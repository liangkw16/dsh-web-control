import assert from 'node:assert/strict'
import ts from 'typescript'
import { builtinModules } from 'node:module'

/** Own source regions are intended bundling; DSH/reference implementations are not. */
export function verifyRuntimeImports(content: string): void {
  assert(!/(?:^|[\s/'"])(?:deepseek-harness|ZCode|happy)\//m.test(content), 'bundled reference path')
  for (const match of content.matchAll(/^\s*\/\/#region\s+([^\r\n]+)/gm)) {
    const region = match[1]
    assert(!/(?:node_modules\/.*@deepseek-ai|@deepseek-ai[+/])/.test(region), 'bundled DSH core source region')
    assert(!/(?:^|\/)src\//.test(region) || /^(?:src\/|\.\.\/protocol\/src\/)/.test(region), 'private source or reference region')
  }
  const source = ts.createSourceFile('packed.js', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const bundledFactories = new Set<string>()
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^require_[a-zA-Z0-9_$]+$/.test(node.name.text)
      && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === '__commonJSMin') bundledFactories.add(node.name.text)
    ts.forEachChild(node, collect)
  }
  collect(source)
  const requireName = (name: string): boolean => /(?:^|_)require(?:$|[$_\d])/.test(name)
  const isRequire = (expression: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(expression)) return isRequire(expression.expression)
    // Transpilers emit indirect calls such as (0, module.require)(specifier).
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) return isRequire(expression.right)
    if (ts.isIdentifier(expression)) return requireName(expression.text)
    if (ts.isPropertyAccessExpression(expression)) return requireName(expression.name.text)
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) return requireName(expression.argumentExpression.text)
    return false
  }
  const check = (value: ts.Expression): void => {
    assert(ts.isStringLiteralLike(value), 'nonliteral runtime import cannot be verified')
    const specifier = value.text
    assert(!/(?:^|\/)(?:deepseek-harness|ZCode|happy)\//.test(specifier), 'reference source import')
    assert(!/(?:^|\/)src\//.test(specifier), 'private source import')
    assert(builtinModules.includes(specifier) || /^(?:\.|node:|@deepseek-ai\/|react$)/.test(specifier), 'unexpected runtime import ' + specifier)
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) check(node.moduleSpecifier)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || isRequire(node.expression))) {
      if (node.arguments.length === 0 && ts.isIdentifier(node.expression) && bundledFactories.has(node.expression.text)) return
      assert(node.arguments.length > 0, 'runtime import requires a specifier')
      check(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
