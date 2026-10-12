import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { cspLoaderSource, inlineStyleHashes } from '../../scripts/native-ui-startup.mjs'

const runtime=resolve('data/compat/runtime-0.2.0-rc.2')
test('stock spreadsheet JSX styles hash only literal template substitutions',()=>{
  const source='boot();const css=".sheet{color:red}"; const scoped=`@scope ([data-excel-preview]) { ${css} }`; jsx("style",{children:scoped}); jsx("style",{children:`${window.userCss}`})'
  expect(inlineStyleHashes(source)).toEqual(["'sha256-"+createHash('sha256').update('@scope ([data-excel-preview]) { .sheet{color:red} }').digest('base64')+"'"])
})
test('remote loader works with string compilation forbidden and rejects nested expression config',async()=>{
  const input=await readFile(join(runtime,'node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js'),'utf8')
  const dir=await mkdtemp(join(tmpdir(),'native-csp-loader-'))
  try{
    await symlink(join(runtime,'node_modules'),join(dir,'node_modules'))
    await writeFile(join(dir,'loader.mjs'),cspLoaderSource(input))
    await writeFile(join(dir,'test.mjs'),`import {interpolate,evaluate} from './loader.mjs';
      const clean=interpolate({}, {plugins:[{name:'native',config:{enabled:true}}]});
      let rejected=0;for(const run of [()=>evaluate({},'1+1'),()=>interpolate({}, {nested:[{__jsExpr:'globalThis.compromised=true'}]})])try{run()}catch(e){if(e.message.includes('expressions are disabled'))rejected++}
      console.log(JSON.stringify({clean,rejected,compromised:globalThis.compromised===true}));`)
    const result=JSON.parse(execFileSync(process.execPath,['--disallow-code-generation-from-strings',join(dir,'test.mjs')],{encoding:'utf8'}))
    expect(result).toEqual({clean:{plugins:[{name:'native',config:{enabled:true}}]},rejected:2,compromised:false})
  }finally{await rm(dir,{recursive:true,force:true})}
})
test('a changed loader release cannot be silently patched',async()=>{
  const input=await readFile(join(runtime,'node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js'),'utf8')
  expect(()=>cspLoaderSource(input+'\n')).toThrow(/unreviewed/i)
})
test('style hashes preserve literal bytes and distinguish scoped constants without executing bundles',()=>{
  const source='function a(){const css=".a{color:red}"; const tag=document.createElement("style");tag.textContent=css;} function b(){const css=".b{color:blue}\\n";const tag=document.createElement("style");tag.textContent=css;} throw new Error("never execute");'
  const hash=(s:string)=>"'sha256-"+createHash('sha256').update(s).digest('base64')+"'"
  expect(inlineStyleHashes(source)).toEqual([hash('.a{color:red}'),hash('.b{color:blue}\n')])
})

import { buildNativeStartup } from '../../scripts/native-ui-startup.mjs'
import ts from 'typescript'
import vm from 'node:vm'
test('startup overlay preserves the shipped singleton code and rejects source drift',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'native-startup-overlay-'))
  try{
    const receipt=await buildNativeStartup({runtimeRoot:runtime,outputDir:join(dir,'overlay')})
    const source=await readFile(join(runtime,'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-5SrrfWpU.js'),'utf8')
    const output=await readFile(join(dir,'overlay',receipt.entry),'utf8')
    const ast=ts.createSourceFile('shell.js',source,ts.ScriptTarget.Latest,true)
    let evaluator:ts.NewExpression|undefined
    function visit(node:ts.Node){if(ts.isNewExpression(node)&&node.expression.getText(ast)==='Function')evaluator=node;ts.forEachChild(node,visit)}visit(ast)
    expect(evaluator).toBeDefined()
    expect(output.startsWith(source.slice(0,evaluator!.getStart(ast)))).toBe(true)
    const patched=ts.createSourceFile('remote.js',output,ts.ScriptTarget.Latest,true)
    let replacement:ts.FunctionExpression|undefined,entryCall:ts.CallExpression|undefined
    function inspect(node:ts.Node){if(ts.isFunctionExpression(node)&&node.name?.text==='evaluate')replacement=node;if(ts.isCallExpression(node)&&node.expression.getText(patched)==='globalThis.__DSH_REMOTE_ENTRY__.start')entryCall=node;ts.forEachChild(node,inspect)}inspect(patched)
    expect(entryCall,'startup must expose the public AppWebEntry lifecycle before run').toBeDefined()
    expect(replacement).toBeDefined()
    const replacedRun=ast.statements.filter(ts.isTryStatement).at(-1)!.tryBlock.statements.filter(ts.isExpressionStatement).at(-1)!.expression
    const expected=source.slice(0,evaluator!.getStart(ast))+replacement!.getText(patched)+source.slice(evaluator!.end,replacedRun.getStart(ast))+entryCall!.getText(patched)+source.slice(replacedRun.end)
    expect(output).toBe(expected)
    const run=vm.runInNewContext('('+replacement!.getText(patched)+')',{}, {contextCodeGeneration:{strings:false,wasm:false}})
    expect(()=>run({},'1+1')).toThrow(/expressions are disabled/)
    expect(receipt.assets[0]!.sha256).toBe(createHash('sha256').update(output).digest('hex'))
    expect(receipt.entry.startsWith('assets/')).toBe(true) // Preserve relative vendor and lazy language imports.
  }finally{await rm(dir,{recursive:true,force:true})}
})
test('hashes literal theme table rows without evaluating the theme installer',()=>{
  const hash=(s:string)=>"'sha256-"+createHash('sha256').update(s).digest('base64')+"'"
  const source='const base="body{color:red}", other="no CSS permission";const STYLES=[["base.css",base],["focus.css",":focus{outline:auto}"]];for(const [name,css]of STYLES){const tag=document.createElement("style");tag.textContent=css;document.head.append(tag)}'
  expect(inlineStyleHashes(source)).toEqual([hash('body{color:red}'),hash(':focus{outline:auto}')])
})
