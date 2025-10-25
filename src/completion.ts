import type * as lsp from "vscode-languageserver-protocol"
import {EditorState, Extension} from "@codemirror/state"
import {CompletionSource, Completion, CompletionContext, snippet, autocompletion} from "@codemirror/autocomplete"
import {LSPPlugin} from "./plugin"

/// Register the [language server completion
/// source](#lsp-client.serverCompletionSource) as an autocompletion
/// source.
export function serverCompletion(config: {
  /// By default, the completion source that asks the language server
  /// for completions is added as a regular source, in addition to any
  /// other sources. Set this to true to make it replace all
  /// completion sources.
  override?: boolean
} = {}): Extension {
  if (config.override) {
    return autocompletion({override: [serverCompletionSource]})
  } else {
    let data = [{autocomplete: serverCompletionSource}]
    return [autocompletion(), EditorState.languageData.of(() => data)]
  }
}

function getCompletions(plugin: LSPPlugin, pos: number, context: lsp.CompletionContext, abort?: CompletionContext) {
  if (plugin.client.hasCapability("completionProvider") === false) return Promise.resolve(null)
  plugin.client.sync()
  let params: lsp.CompletionParams = {
    position: plugin.toPosition(pos),
    textDocument: {uri: plugin.uri},
    context
  }
  if (abort) abort.addEventListener("abort", () => plugin.client.cancelRequest(params))
  return plugin.client.request<lsp.CompletionParams, lsp.CompletionItem[] | lsp.CompletionList | null>(
    "textDocument/completion", params)
}

// Look for non-alphanumeric prefixes in the completions, and return a
// regexp that matches them, to use in validFor
function prefixRegexp(items: readonly lsp.CompletionItem[]) {
  let step = Math.ceil(items.length / 50), prefixes: string[] = []
  for (let i = 0; i < items.length; i += step) {
    let item = items[i], text = item.textEdit?.newText || item.textEditText || item.insertText || item.label
    if (!/^\w/.test(text)) {
      let prefix = /^[^\w]*/.exec(text)![0]
      if (prefixes.indexOf(prefix) < 0) prefixes.push(prefix)
    }
  }
  if (!prefixes.length) return /^\w*$/
  return new RegExp("^(?:" + prefixes.map((RegExp as any).escape || (s => s.replace(/[^\w\s]/g, "\\$&"))).join("|") + ")?\\w*$")
}

/// A completion source that requests completions from a language
/// server.
export const serverCompletionSource: CompletionSource = context => {
  const plugin = context.view && LSPPlugin.get(context.view)
  if (!plugin) return null
  let triggerChar = ""
  if (!context.explicit) {
    triggerChar = context.view.state.sliceDoc(context.pos - 1, context.pos)
    let triggers = plugin.client.serverCapabilities?.completionProvider?.triggerCharacters
    if (!/[a-zA-Z_]/.test(triggerChar) && !(triggers && triggers.indexOf(triggerChar) > -1)) return null
  }
  return getCompletions(plugin, context.pos, {
    triggerCharacter: triggerChar,
    triggerKind: context.explicit ? 1 /* Invoked */ : 2 /* TriggerCharacter */
  }, context).then(result => {
    if (!result) return null
    if (Array.isArray(result)) result = {items: result} as lsp.CompletionList
    let {from, to} = completionResultRange(context, result)
    let defaultCommitChars = result.itemDefaults?.commitCharacters

    return {
      from, to,
      options: result.items.map<Completion>(item => {
        let text = item.textEdit?.newText || item.textEditText || item.insertText || item.label
        // 使用 filterText 作为 label 来匹配用户输入，如果没有则使用原始 label
        let displayLabel = item.filterText || item.label
        let option: Completion = {
          label: displayLabel,
          type: item.kind && kindToType[item.kind],
        }
        if (item.commitCharacters && item.commitCharacters != defaultCommitChars)
          option.commitCharacters = item.commitCharacters
        if (item.detail) option.detail = item.detail
        if (item.insertTextFormat == 2 /* Snippet */) {
          option.apply = (view, c, from, to) => snippet(text)(view, c, from, to)
          // 保持使用 filterText 作为 label，以便正确匹配
          option.label = item.filterText || item.label
        }
        if (item.documentation) option.info = () => renderDocInfo(plugin, item.documentation!)
        return option
      }),
      commitCharacters: defaultCommitChars,
      validFor: prefixRegexp(result.items),
      addToOptions: addCompletionIcons,
      map: (result, changes) => ({...result, from: changes.mapPos(result.from)}),
    }
  }, err => {
    if ("code" in err && (err as lsp.ResponseError).code == -32800 /* RequestCancelled */)
      return null
    throw err
  })
}

function completionResultRange(cx: CompletionContext, result: lsp.CompletionList): {from: number, to: number} {
  if (!result.items.length) return {from: cx.pos, to: cx.pos}
  let defaultRange = result.itemDefaults?.editRange, item0 = result.items[0]
  let range = defaultRange ? ("insert" in defaultRange ? defaultRange.insert : defaultRange)
    : item0.textEdit ? ("range" in item0.textEdit ? item0.textEdit.range : item0.textEdit.insert)
    : null
  if (!range) return cx.state.wordAt(cx.pos) || {from: cx.pos, to: cx.pos}
  // 使用 range 中的行号，而不是 cx.pos 所在的行
  // LSP 行号从 0 开始，CodeMirror 从 1 开始
  let line = cx.state.doc.line(range.start.line + 1)
  let calculatedFrom = line.from + range.start.character
  let calculatedTo = line.from + range.end.character
  // 确保 to >= cx.pos，这样 CodeMirror 才会显示补全
  if (calculatedTo < cx.pos) calculatedTo = cx.pos
  return {from: calculatedFrom, to: calculatedTo}
}

function renderDocInfo(plugin: LSPPlugin, doc: string | lsp.MarkupContent) {
  let elt = document.createElement("div")
  elt.className = "cm-lsp-documentation cm-lsp-completion-documentation"
  elt.innerHTML = plugin.docToHTML(doc)
  return elt
}

const kindToType: {[kind: number]: string} = {
  1: "text", // Text
  2: "method", // Method
  3: "function", // Function
  4: "class", // Constructor
  5: "property", // Field
  6: "variable", // Variable
  7: "class", // Class
  8: "interface", // Interface
  9: "namespace", // Module
  10: "property", // Property
  11: "keyword", // Unit
  12: "constant", // Value
  13: "constant", // Enum
  14: "keyword", // Keyword
  16: "constant", // Color
  20: "constant", // EnumMember
  21: "constant", // Constant
  22: "class", // Struct
  25: "type" // TypeParameter
}

const kindToIcon: {[kind: string]: string} = {
  function: "ƒ",
  method: "ƒ",
  class: "C",
  interface: "I",
  variable: "v",
  property: "p",
  keyword: "k",
  constant: "c",
  text: "t",
  namespace: "n",
  type: "T"
}

function addCompletionIcons(options: readonly Completion[]) {
  return options.map(option => {
    if (!option.type) return option
    let icon = kindToIcon[option.type] || option.type.charAt(0).toUpperCase()
    return {
      ...option,
      label: option.label,
      displayLabel: option.label,
      boost: (option as any).boost,
      section: (option as any).section,
      apply: option.apply,
      info: option.info,
      detail: option.detail,
      type: option.type,
      commitCharacters: (option as any).commitCharacters,
      render: (completion: Completion, _state: any, match: readonly number[]) => {
        let elt = document.createElement("div")
        elt.className = "cm-completionLabel"
        
        // 创建图标元素
        let iconElt = document.createElement("span")
        iconElt.className = `cm-completionIcon cm-completionIcon-${option.type}`
        iconElt.textContent = icon
        elt.appendChild(iconElt)
        
        // 创建标签文本
        let labelElt = document.createElement("span")
        labelElt.className = "cm-completionLabelText"
        let label = completion.displayLabel || completion.label
        
        // 添加匹配高亮
        if (match.length > 0) {
          let lastIndex = 0
          for (let i = 0; i < match.length; i++) {
            let pos = match[i]
            if (pos > lastIndex) {
              labelElt.appendChild(document.createTextNode(label.slice(lastIndex, pos)))
            }
            let matchElt = document.createElement("span")
            matchElt.className = "cm-completionMatchedText"
            matchElt.textContent = label[pos]
            labelElt.appendChild(matchElt)
            lastIndex = pos + 1
          }
          if (lastIndex < label.length) {
            labelElt.appendChild(document.createTextNode(label.slice(lastIndex)))
          }
        } else {
          labelElt.textContent = label
        }
        
        elt.appendChild(labelElt)
        return elt
      }
    }
  })
}
