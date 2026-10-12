/** Build the approved remote-only startup overlay; never write into stock artifacts. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ts from 'typescript';
const sha = text => createHash('sha256').update(text).digest('hex');
const loaderSha = 'b57c5075e881b4ceb3a15382f506ce549bcbdcd2a0f5bae292f67e6a83a45b1f';
/** One reviewed AST initializer, in the public loader module, at build time only. */
export function cspLoaderSource(source) {
  return replaceEvaluator(source, loaderSha);
}
const shellSha = 'af3ff948cf3f132edbddebea93e2f9f02233b390a94bd4c9842182300be811bb';
function replaceEvaluator(source, expected) {
  if (sha(source) !== expected) throw new Error('Unreviewed loader source; re-audit the startup exception');
  const ast = ts.createSourceFile('loader.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = [];
  const visit = node => {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'Function') matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (matches.length !== 1) throw new Error('Unreviewed loader evaluator shape');
  const node = matches[0];
  return source.slice(0, node.getStart(ast)) + 'function evaluate() { throw new Error("Remote loader configuration expressions are disabled"); }' + source.slice(node.end);
}
/** Route only the entry invocation through our owner; AppWebEntry itself stays byte-identical. */
function ownStartup(source) {
  const ast=ts.createSourceFile('shell.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const boot=ast.statements.filter(ts.isTryStatement).at(-1);
  const statement=boot?.tryBlock.statements.filter(ts.isExpressionStatement).at(-1);
  const call=statement?.expression;
  if(!call||!ts.isCallExpression(call)||!ts.isPropertyAccessExpression(call.expression)||call.expression.name.text!=='run'||!ts.isIdentifier(call.expression.expression))throw new Error('Unreviewed startup invocation');
  const owner=call.expression.expression.getText(ast);
  return source.slice(0,call.getStart(ast))+'globalThis.__DSH_REMOTE_ENTRY__.start('+owner+')'+source.slice(call.end);
}
/** Hash literal style payloads without evaluating any upstream module or accepting arbitrary inline CSS. */
export function inlineStyleHashes(source) {
  const ast = ts.createSourceFile('bundle.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const parents = new Map(), declarations = new Map(), scopes = new Map();
  const collect = (node, parent) => {
    const boundary = ts.isSourceFile(node) || ts.isBlock(node);
    const scope = boundary ? node : parent;
    if (boundary) { parents.set(node, parent); declarations.set(node, new Map()); }
    scopes.set(node, scope);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.get(scope).set(node.name.text, node.initializer);
    ts.forEachChild(node, child => collect(child, scope));
  };
  collect(ast, undefined);
  const literal = (node, scope, depth=0) => {
    if (!node || depth>16) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      let value=node.head.text;
      for(const span of node.templateSpans){const part=literal(span.expression,scope,depth+1);if(part===undefined)return;value+=part+span.literal.text}
      return value;
    }
    if (!ts.isIdentifier(node)) return;
    for (let current = scope; current; current = parents.get(current)) {
      const value = declarations.get(current)?.get(node.text);
      if (value) return literal(value,current,depth+1);
    }
  };
  const hashes = new Set();
  const add = value => { if (value !== undefined) hashes.add("'sha256-" + createHash('sha256').update(value).digest('base64') + "'"); };
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'textContent') {
      const value = literal(node.right, scopes.get(node));
      add(value);
    }
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 2 && ts.isStringLiteral(node.elements[0])
      && node.elements[0].text.endsWith('.css')) add(literal(node.elements[1], scopes.get(node)));
    // Stock React style elements can use a static, locally scoped CSS template.
    if(ts.isCallExpression(node)&&node.arguments.length>=2&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text==='style'&&ts.isObjectLiteralExpression(node.arguments[1])){
      const child=node.arguments[1].properties.find(prop=>ts.isPropertyAssignment(prop)&&prop.name.getText(ast)==='children');
      if(child)add(literal(child.initializer,scopes.get(node)));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); return [...hashes];
}
export async function buildNativeStartup({ runtimeRoot, outputDir }) {
  await mkdir(outputDir); // Never overwrite the collected stock artifact tree.
  const sourcePackage = '@deepseek-ai/dsh-web-frontend', sourceVersion = '0.2.0-rc.2';
  const pkgRoot = join(runtimeRoot, 'node_modules', sourcePackage);
  const pkg = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'));
  if (pkg.name !== sourcePackage || pkg.version !== sourceVersion) throw new Error('Unreviewed startup release');
  const inputPath = 'dist/assets/index-5SrrfWpU.js';
  const source = await readFile(join(pkgRoot, inputPath), 'utf8');
  const output = ownStartup(replaceEvaluator(source, shellSha));
  // Same relative directory as the original: vendor and language chunks stay immutable.
  const entry = 'assets/remote-shell-' + sha(output).slice(0, 16) + '.js';
  await mkdir(dirname(join(outputDir, entry)), { recursive: true });
  await writeFile(join(outputDir, entry), output, { flag: 'wx' });
  const license = await readFile(join(pkgRoot, 'LICENSE'));
  const licensePath = 'licenses/remote-shell.txt';
  await mkdir(join(outputDir, 'licenses')); await writeFile(join(outputDir, licensePath), license, { flag: 'wx' });
  const assets = [{ path: entry, sha256: sha(output), bytes: Buffer.byteLength(output) }, { path: licensePath, sha256: sha(license), bytes: license.length }];
  const stylePath='remote-layout.css',style=await readFile(join(import.meta.dirname,'../packages/web/src/native-ui/mobile.css'));
  await writeFile(join(outputDir,stylePath),style,{flag:'wx'});assets.push({path:stylePath,sha256:sha(style),bytes:style.length});
  const receipt = {
    schema: 1, dshVersion: sourceVersion, entry, styles: [stylePath],
    change: { package: '@deepseek-ai/cordis-plugin-loader', version: '1.0.5', sourceSha256: loaderSha,
      replacement: 'The evaluator initializer rejects expressions; the entry invocation hands its public AppWebEntry to the remote lifecycle owner. All other shipped bytes preserved' },
    inputs: [{ package: sourcePackage, version: sourceVersion, path: inputPath, sha256: shellSha }], assets,
    licenses: [{ package: sourcePackage, version: sourceVersion, license: 'MIT', path: licensePath }],
    builderSha256: sha(await readFile(import.meta.filename)),
  };
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}
