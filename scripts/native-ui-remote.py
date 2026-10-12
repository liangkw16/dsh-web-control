#!/usr/bin/env python3
"""Single-host release operations. Python 3.6 compatible; never logs secrets."""
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

BASE = Path('/opt/dsh-web-control/native-release')
LIVE = Path('/opt/dsh-web-control/live/compose.yaml')
NGINX = Path('/etc/nginx/conf.d/dsh-web-control-ip.conf')
PROJECT = 'dsh-web-control-ip'
CONTAINER = PROJECT + '-relay-1'
VOLUME = PROJECT + '_relay_data'
OLD_IMAGE = 'sha256:0cf82dfe1d47125bcf0f8de0a592ac2edc94893b5d30a73acd888ea8b3bbaae6'
OLD_NGINX = '5fe945c7bb80646ad42f7301ff41b51b66adf284a6c9b69f4cfa6b2b07b03356'

def command(argv):
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if result.returncode:
        raise RuntimeError('Command failed: ' + argv[0] + ' ' + argv[1])
    return result.stdout

def digest(path):
    h = hashlib.sha256()
    with open(str(path), 'rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()

def read_json(path):
    with open(str(path)) as f:
        return json.load(f)

def write_json(path, value):
    with open(str(path), 'x') as f:
        json.dump(value, f, indent=2)
    os.chmod(str(path), 0o600)

def facts(expected, require_running=True):
    item = json.loads(command(['docker', 'inspect', CONTAINER]))[0]
    compose = json.loads(command(['docker', 'compose', '--project-name', PROJECT, '--project-directory', str(LIVE.parent), '-f', str(LIVE), 'config', '--format', 'json']))
    labels = item['Config']['Labels']
    mounts = item['Mounts']
    env = dict(v.split('=', 1) for v in item['Config']['Env'])
    if (item['Image'] != expected or compose['services']['relay']['image'] != expected
            or labels.get('com.docker.compose.project') != PROJECT
            or labels.get('com.docker.compose.service') != 'relay'
            or labels.get('com.docker.compose.project.config_files') != str(LIVE)
            or (require_running and not item['State']['Running'])
            or not any(m.get('Name') == VOLUME and m['Destination'] == '/data' for m in mounts)
            or not any(m.get('Source') == '/opt/dsh-web-control/live/secrets/enrollment' and m['Destination'] == '/run/secrets/enrollment' for m in mounts)
            or env.get('PUBLIC_ORIGIN') != 'https://203.0.113.25:8443'
            or env.get('DATABASE_PATH') != '/data/relay.sqlite'
            or env.get('ENROLLMENT_SECRET_FILE') != '/run/secrets/enrollment'):
        raise RuntimeError('Production identity drift; refusing change')

def compose_up():
    command(['docker', 'compose', '--project-name', PROJECT, '--project-directory', str(LIVE.parent), '-f', str(LIVE), 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'relay'])

def backup(directory):
    facts(OLD_IMAGE)
    if digest(NGINX) != OLD_NGINX:
        raise RuntimeError('Nginx preflight drift')
    command(['nginx', '-t'])
    b = directory / 'backup'
    b.mkdir(mode=0o700)
    sources = [LIVE, NGINX, LIVE.parent / 'secrets/enrollment',
               Path('/etc/letsencrypt/live/203.0.113.25/fullchain.pem'),
               Path('/etc/letsencrypt/live/203.0.113.25/privkey.pem')]
    if (LIVE.parent / '.env').exists():
        sources.append(LIVE.parent / '.env')
    files = []
    for i, src in enumerate(sources):
        dest = b / ('file-' + str(i))
        st = src.stat()
        shutil.copyfile(str(src), str(dest))
        os.chmod(str(dest), 0o600)
        files.append({'source': str(src), 'file': dest.name, 'sha256': digest(dest),
                      'mode': st.st_mode & 0o777, 'uid': st.st_uid, 'gid': st.st_gid})
    database = '/data/native-' + directory.name + '.sqlite'
    command(['docker', 'exec', CONTAINER, 'node', 'dist/cli.js', 'backup', '--destination', database])
    command(['docker', 'cp', CONTAINER + ':' + database, str(b / 'relay.sqlite')])
    os.chmod(str(b / 'relay.sqlite'), 0o600)
    db = sqlite3.connect('file:' + str(b / 'relay.sqlite') + '?mode=ro', uri=True)
    try:
        if db.execute('pragma integrity_check').fetchone()[0] != 'ok' or db.execute('pragma foreign_key_check').fetchall() or db.execute('select version from schema_migrations order by version').fetchall() != [(1,)]:
            raise RuntimeError('Database backup validation failed')
    finally:
        db.close()
    command(['docker', 'image', 'save', '--output', str(b / 'old-image.tar'), OLD_IMAGE])
    os.chmod(str(b / 'old-image.tar'), 0o600)
    record = {'schema': 1, 'kind': 'native-ui-backup', 'status': 'PASS', 'previousImage': OLD_IMAGE,
              'project': PROJECT, 'volume': VOLUME, 'files': files,
              'databaseSha256': digest(b / 'relay.sqlite'), 'imageArchiveSha256': digest(b / 'old-image.tar')}
    write_json(b / 'manifest.json', record)
    return {'status': 'PASS', 'kind': 'native-ui-backup', 'manifestSha256': digest(b / 'manifest.json'), 'previousImage': OLD_IMAGE}

def verify_backup(directory, expected_hash):
    b = directory / 'backup'
    if digest(b / 'manifest.json') != expected_hash:
        raise RuntimeError('Backup manifest hash mismatch')
    m = read_json(b / 'manifest.json')
    if m['status'] != 'PASS' or m['previousImage'] != OLD_IMAGE or m['project'] != PROJECT or m['volume'] != VOLUME:
        raise RuntimeError('Invalid backup')
    if digest(b / 'relay.sqlite') != m['databaseSha256'] or digest(b / 'old-image.tar') != m['imageArchiveSha256']:
        raise RuntimeError('Backup archive corruption')
    for f in m['files']:
        if digest(b / f['file']) != f['sha256']:
            raise RuntimeError('Backup file corruption')
    return m

def replace_file(path, data, mode, uid, gid):
    tmp = path.with_name(path.name + '.native-stage')
    with open(str(tmp), 'xb') as f:
        f.write(data)
    os.chmod(str(tmp), mode)
    os.chown(str(tmp), uid, gid)
    os.replace(str(tmp), str(path))

def restore_configs(directory, m):
    for f in m['files']:
        path = Path(f['source'])
        if path in [LIVE, NGINX]:
            replace_file(path, (directory / 'backup' / f['file']).read_bytes(), f['mode'], f['uid'], f['gid'])
    command(['nginx', '-t'])
    command(['nginx', '-s', 'reload'])
    command(['docker', 'image', 'load', '--input', str(directory / 'backup/old-image.tar')])
    compose_up()
    facts(OLD_IMAGE)

def nginx_buffers(text):
    target = 'proxy_pass http://127.0.0.1:18787;'
    expected = target + '\n        proxy_buffer_size 16k;\n        proxy_buffers 8 16k;\n        proxy_buffering off;'
    if text.count(target) == 1 and text.count(expected) == 1 and not re.search(r'\bproxy_(?:buffer_size|buffers|buffering)\s', text.replace(expected, target)):
        return text
    if text.count(target) != 1 or re.search(r'\bproxy_(?:buffer_size|buffers|buffering)\s', text):
        raise RuntimeError('Unexpected Nginx buffer configuration')
    return text.replace(target, expected)

def relay_image(text, image):
    # Docker Compose already validated/resolved the relay image in facts(). Keep
    # every other source byte, including flow-style mounts and .env references.
    sections = list(re.finditer(r'^services:[ \t]*(?:#.*)?\n', text, re.MULTILINE))
    if len(sections) != 1:
        raise RuntimeError('Ambiguous services declaration')
    start = sections[0].end()
    end_match = re.search(r'^[^ \t\r\n#]', text[start:], re.MULTILINE)
    end = start + end_match.start() if end_match else len(text)
    services = text[start:end]
    relays = list(re.finditer(r'^  relay:[ \t]*(?:#.*)?\n', services, re.MULTILINE))
    if len(relays) != 1:
        raise RuntimeError('Unsupported relay service declaration')
    begin = start + relays[0].end()
    next_service = re.search(r'^  [^ \t\r\n#]', text[begin:end], re.MULTILINE)
    finish = begin + next_service.start() if next_service else end
    block = text[begin:finish]
    pattern = r'^(    image:[ \t]*)([\'\"]?)' + re.escape(OLD_IMAGE) + r'\2([ \t]*(?:#.*)?)$'
    matches = list(re.finditer(pattern, block, re.MULTILINE))
    if len(matches) != 1:
        raise RuntimeError('Ambiguous relay image declaration')
    match = matches[0]
    return text[:begin + match.start()] + match.group(1) + match.group(2) + image + match.group(2) + match.group(3) + text[begin + match.end():]

def activate(directory, backup_hash):
    m = verify_backup(directory, backup_hash)
    facts(OLD_IMAGE)
    # Refuse changes since backup, including TLS renewal/enrollment/config edits.
    for f in m['files']:
        if digest(Path(f['source'])) != f['sha256']:
            raise RuntimeError('Production file changed after backup')
    plan = read_json(directory / 'activation.json')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', plan['runtimeImage']) or not re.fullmatch(r'[a-f0-9]{64}', plan['sourceDigest']):
        raise RuntimeError('Invalid image binding')
    if digest(directory / 'candidate.tar') != plan['archiveSha256']:
        raise RuntimeError('Uploaded image hash mismatch')
    command(['docker', 'image', 'load', '--input', str(directory / 'candidate.tar')])
    item = json.loads(command(['docker', 'image', 'inspect', plan['runtimeImage']]))[0]
    if item['Id'] != plan['runtimeImage'] or item['Os'] != 'linux' or item['Architecture'] != 'amd64' or item['Config']['Labels'].get('io.dsh.source') != plan['sourceDigest']:
        raise RuntimeError('Loaded image identity mismatch')
    compose = relay_image(LIVE.read_text(), plan['runtimeImage'])
    nginx = nginx_buffers(NGINX.read_text())
    try:
        for path, content in [(NGINX, nginx.encode()), (LIVE, compose.encode())]:
            st = path.stat()
            replace_file(path, content, st.st_mode & 0o777, st.st_uid, st.st_gid)
        command(['nginx', '-t'])
        command(['nginx', '-s', 'reload'])
        compose_up()
        facts(plan['runtimeImage'])
        command(['curl', '--fail', '--silent', '--show-error', 'https://203.0.113.25:8443/health/ready'])
    except Exception:
        restore_configs(directory, m)
        raise RuntimeError('Activation failed; previous image/config restored; live database retained')
    result = {'status': 'PASS', 'kind': 'native-ui-activation', 'runtimeImage': plan['runtimeImage'], 'databaseRestored': False}
    write_json(directory / 'activated.json', result)
    return result

def rollback(directory, backup_hash):
    m = verify_backup(directory, backup_hash)
    plan = read_json(directory / 'activation.json')
    facts(plan['runtimeImage'], require_running=False)
    restore_configs(directory, m)
    command(['curl', '--fail', '--silent', '--show-error', 'https://203.0.113.25:8443/health/ready'])
    return {'status': 'PASS', 'kind': 'native-ui-rollback', 'runtimeImage': OLD_IMAGE, 'databaseRestored': False}

def main():
    os.umask(0o077)
    action, location = sys.argv[1:3]
    directory = Path(location).resolve()
    if directory.parent != BASE or not re.fullmatch(r'[a-f0-9]{16}-[a-f0-9]{8}', directory.name):
        raise RuntimeError('Not an owned release directory')
    if action == 'backup':
        result = backup(directory)
    elif action in ['activate', 'rollback'] and re.fullmatch(r'[a-f0-9]{64}', sys.argv[3]):
        result = (activate if action == 'activate' else rollback)(directory, sys.argv[3])
    else:
        raise RuntimeError('Unsupported action')
    print(json.dumps(result))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'status': 'FAIL', 'error': str(e)}))
        sys.exit(1)
