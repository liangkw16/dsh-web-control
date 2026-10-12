import importlib.util
import json
import os
import tempfile
import unittest
import yaml
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote', Path(__file__).resolve().parents[2] / 'scripts/native-ui-remote.py')
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)

class RemoteDeployment(unittest.TestCase):
    def test_compose_flow_mount_syntax_is_preserved_byte_for_byte_except_image(self):
        original = 'services:\n  relay:\n    image: ' + remote.OLD_IMAGE + '\n    volumes: [relay_data:/data]\n'
        image = 'sha256:' + 'a' * 64
        self.assertEqual(remote.relay_image(original, image), original.replace(remote.OLD_IMAGE, image))
        with self.assertRaises(RuntimeError):
            remote.relay_image(original + original, image)

    def test_same_image_in_admin_service_is_retained(self):
        original = 'services:\n  relay:\n    image: ' + remote.OLD_IMAGE + '\n    volumes: [relay_data:/data]\n  admin:\n    image: ' + remote.OLD_IMAGE + '\n    profiles: [admin]\n'
        image = 'sha256:' + 'a' * 64
        self.assertEqual(remote.relay_image(original, image), original.replace(remote.OLD_IMAGE, image, 1))
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='native-remote-unit-')
        self.dir = Path(self.tmp.name)
        self.live = self.dir / 'compose.yaml'
        self.nginx = self.dir / 'nginx.conf'
        self.compose = {'services': {'relay': {'image': remote.OLD_IMAGE, 'environment': {'DATABASE_PATH': '/data/relay.sqlite'}, 'volumes': ['data:/data']}, 'other': {'image': 'untouched'}}, 'volumes': {'data': {}}}
        self.live.write_text(yaml.safe_dump(self.compose))
        self.nginx.write_text('location / { proxy_pass http://127.0.0.1:18787; }')
        b = self.dir / 'backup'
        b.mkdir()
        files = []
        for i, src in enumerate([self.live, self.nginx]):
            target = b / str(i)
            target.write_bytes(src.read_bytes())
            files.append({'source': str(src), 'file': str(i), 'sha256': remote.digest(target), 'mode': 0o600, 'uid': os.getuid(), 'gid': os.getgid()})
        (b / 'relay.sqlite').write_bytes(b'fixture snapshot')
        (b / 'old-image.tar').write_bytes(b'fixture old image')
        remote.write_json(b / 'manifest.json', {'status': 'PASS', 'previousImage': remote.OLD_IMAGE, 'project': remote.PROJECT, 'volume': remote.VOLUME, 'files': files, 'databaseSha256': remote.digest(b / 'relay.sqlite'), 'imageArchiveSha256': remote.digest(b / 'old-image.tar')})
        self.backup_hash = remote.digest(b / 'manifest.json')
        (self.dir / 'candidate.tar').write_bytes(b'fixture candidate')
        self.image = 'sha256:' + 'a' * 64
        self.source = 'b' * 64
        remote.write_json(self.dir / 'activation.json', {'runtimeImage': self.image, 'sourceDigest': self.source, 'archiveSha256': remote.digest(self.dir / 'candidate.tar')})
        self.calls = []
        self.failed = False
        self.fail_up = False
        self.patches = [patch.object(remote, 'LIVE', self.live), patch.object(remote, 'NGINX', self.nginx), patch.object(remote, 'facts'), patch.object(remote, 'command', self.command)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def command(self, argv):
        self.calls.append(argv)
        if argv[:3] == ['docker', 'image', 'inspect']:
            return json.dumps([{'Id': self.image, 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Labels': {'io.dsh.source': self.source}}}])
        if 'up' in argv and self.fail_up and not self.failed:
            self.failed = True
            raise RuntimeError('fixture compose failure')
        return ''

    def test_activation_preserves_all_other_compose_fields_and_sets_buffers(self):
        result = remote.activate(self.dir, self.backup_hash)
        expected = self.compose
        expected['services']['relay']['image'] = self.image
        self.assertEqual(yaml.safe_load(self.live.read_text()), expected)
        self.assertIn('proxy_buffer_size 16k;', self.nginx.read_text())
        self.assertFalse(result['databaseRestored'])
        self.assertFalse(any('down' in a or 'prune' in a for a in self.calls))

    def test_failed_compose_restores_original_files_and_image_without_database_restore(self):
        before = (self.live.read_bytes(), self.nginx.read_bytes())
        self.fail_up = True
        with self.assertRaisesRegex(RuntimeError, 'previous image/config restored'):
            remote.activate(self.dir, self.backup_hash)
        self.assertEqual((self.live.read_bytes(), self.nginx.read_bytes()), before)
        self.assertEqual(sum('up' in a for a in self.calls), 2)
        self.assertFalse(any('restore' in a for a in self.calls))

    def test_backup_corruption_refuses_rollback_before_commands(self):
        (self.dir / 'backup/old-image.tar').write_bytes(b'bad')
        with self.assertRaisesRegex(RuntimeError, 'corruption'):
            remote.rollback(self.dir, self.backup_hash)
        self.assertEqual(self.calls, [])

    def test_configuration_drift_refuses_activation_before_docker_load(self):
        self.live.write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'changed after backup'):
            remote.activate(self.dir, self.backup_hash)
        self.assertEqual(self.calls, [])

    def test_buffers_refuse_ambiguous_or_existing_configuration(self):
        for text in ['different upstream', 'proxy_pass http://127.0.0.1:18787; proxy_buffer_size 4k;']:
            with self.assertRaises(RuntimeError):
                remote.nginx_buffers(text)

    def test_existing_native_buffers_are_preserved_exactly(self):
        source = 'proxy_pass http://127.0.0.1:18787;'
        native = remote.nginx_buffers(source)
        self.assertEqual(remote.nginx_buffers(native), native)
        with self.assertRaises(RuntimeError):
            remote.nginx_buffers(native + '\nproxy_buffers 8 16k;')

    def test_stopped_candidate_can_roll_back_but_wrong_identity_cannot(self):
        # Exercise real facts(), with docker inspection held at an exact stopped candidate.
        self.patches[2].stop()
        self.compose['services']['relay']['image'] = self.image
        self.live.write_text(yaml.safe_dump(self.compose))
        item = {'Image': self.image, 'State': {'Running': False}, 'Config': {'Labels': {
            'com.docker.compose.project': remote.PROJECT, 'com.docker.compose.service': 'relay',
            'com.docker.compose.project.config_files': str(self.live)}, 'Env': [
                'PUBLIC_ORIGIN=https://203.0.113.25:8443', 'DATABASE_PATH=/data/relay.sqlite',
                'ENROLLMENT_SECRET_FILE=/run/secrets/enrollment']}, 'Mounts': [
                    {'Name': remote.VOLUME, 'Destination': '/data'},
                    {'Source': '/opt/dsh-web-control/live/secrets/enrollment', 'Destination': '/run/secrets/enrollment'}]}
        def inspect(argv):
            self.calls.append(argv)
            if 'config' in argv and '--format' in argv:
                return json.dumps(yaml.safe_load(self.live.read_text()))
            if argv[:2] == ['docker', 'inspect']:
                return json.dumps([item])
            if 'up' in argv:
                item['Image'] = remote.OLD_IMAGE
                item['State']['Running'] = True
            return ''
        with patch.object(remote, 'command', inspect):
            result = remote.rollback(self.dir, self.backup_hash)
            self.assertEqual(result['runtimeImage'], remote.OLD_IMAGE)
            self.assertFalse(result['databaseRestored'])
            item['Image'] = 'sha256:' + 'f' * 64
            with self.assertRaisesRegex(RuntimeError, 'identity drift'):
                remote.rollback(self.dir, self.backup_hash)

if __name__ == '__main__':
    unittest.main()
