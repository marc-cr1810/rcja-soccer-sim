/**
 * The code editor, and what it looks like.
 *
 * A textarea was the first attempt and it was the wrong call twice over: the
 * text came out unreadable, and a language where indentation is syntax needs
 * more help than three keyboard shortcuts can give. So this is CodeMirror with
 * the real Python grammar — which brings bracket matching, undo, selection and
 * an indenter that understands a block, none of which is worth hand-rolling.
 *
 * The colours are Visual Studio Code's Dark+, deliberately and precisely. Not
 * because there is anything sacred about them, but because a student who has
 * seen a code editor before has almost certainly seen that one, and the point
 * of this page is to be unsurprising to somebody who has never been given a
 * working environment of their own. The rest of this league's tools are
 * green-on-black because they are scoreboards and consoles; an editor is not
 * one of those, and matching them would have been consistency for its own
 * sake.
 */

import { EditorView, basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { tags } from '@lezer/highlight';

/** VS Code Dark+, as far as this needs it. */
const COLOURS = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  caret: '#aeafad',
  selection: '#264f78',
  lineHighlight: '#2a2d2e',
  gutter: '#858585',
  gutterActive: '#c6c6c6',
  keyword: '#569cd6',
  control: '#c586c0',
  string: '#ce9178',
  number: '#b5cea8',
  comment: '#6a9955',
  function: '#dcdcaa',
  type: '#4ec9b0',
  variable: '#9cdcfe',
  constant: '#569cd6',
  operator: '#d4d4d4',
  invalid: '#f44747',
};

const theme = EditorView.theme(
  {
    '&': {
      color: COLOURS.foreground,
      backgroundColor: COLOURS.background,
      height: '100%',
      fontSize: '13px',
    },
    '.cm-scroller': {
      fontFamily:
        '"SF Mono", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      lineHeight: '1.5',
      overflow: 'auto',
    },
    '.cm-content': { caretColor: COLOURS.caret, padding: '0.5rem 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: COLOURS.caret, borderLeftWidth: '2px' },
    // CodeMirror paints the selection itself once the view is focused, and
    // uses the native one otherwise; both need saying or selecting looks
    // broken the moment the editor loses focus.
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: COLOURS.selection,
    },
    '.cm-activeLine': { backgroundColor: COLOURS.lineHighlight },
    '.cm-gutters': {
      backgroundColor: COLOURS.background,
      color: COLOURS.gutter,
      border: 'none',
      paddingRight: '0.4rem',
    },
    '.cm-activeLineGutter': {
      backgroundColor: COLOURS.lineHighlight,
      color: COLOURS.gutterActive,
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'transparent',
      outline: '1px solid #888888',
      color: 'inherit',
    },
    '.cm-nonmatchingBracket': { color: COLOURS.invalid },
    '.cm-tooltip': {
      backgroundColor: '#252526',
      border: '1px solid #454545',
      color: COLOURS.foreground,
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: '#04395e',
      color: COLOURS.foreground,
    },
    '.cm-panels': { backgroundColor: '#252526', color: COLOURS.foreground },
    '.cm-searchMatch': { backgroundColor: '#613214', outline: '1px solid #f6b26b' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#9e6a03' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'transparent',
      border: 'none',
      color: COLOURS.gutter,
    },
  },
  { dark: true },
);

const highlighting = HighlightStyle.define([
  { tag: tags.comment, color: COLOURS.comment, fontStyle: 'italic' },
  // `def`, `class`, `import`, `lambda` — the blue keywords.
  { tag: [tags.keyword, tags.modifier, tags.self, tags.null], color: COLOURS.keyword },
  // Control flow is the one place VS Code reaches for purple: if, for, while,
  // return, try. Keeping that distinction is most of what makes Python code
  // skimmable at a glance.
  { tag: [tags.controlKeyword, tags.moduleKeyword], color: COLOURS.control },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: COLOURS.string },
  { tag: [tags.number, tags.bool, tags.atom], color: COLOURS.number },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: COLOURS.function },
  { tag: [tags.definition(tags.function(tags.variableName))], color: COLOURS.function },
  { tag: [tags.className, tags.typeName, tags.namespace], color: COLOURS.type },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: COLOURS.variable },
  { tag: [tags.definition(tags.variableName)], color: COLOURS.variable },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: COLOURS.operator },
  { tag: tags.invalid, color: COLOURS.invalid },
  // A decorator — @robot.tick — is the first unfamiliar thing in the starter
  // robot, so it is worth it not looking like punctuation.
  { tag: tags.meta, color: COLOURS.function },
]);

export interface EditorHooks {
  /** Called on every change the user made, for autosave. */
  onChange: () => void;
  /** Ctrl-S / Cmd-S, for somebody who cannot believe there is no save button. */
  onSave: () => void;
}

function extensions(hooks: EditorHooks): Extension[] {
  return [
    basicSetup,
    python(),
    theme,
    syntaxHighlighting(highlighting),
    // Tab indents rather than moving focus. A trade against keyboard
    // navigation that is the right way round here — this is an editor for a
    // whitespace-significant language, and CodeMirror still lets Escape then
    // Tab out of it.
    keymap.of([
      indentWithTab,
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          hooks.onSave();
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) hooks.onChange();
    }),
  ];
}

export class CodeEditor {
  private readonly view: EditorView;
  private readonly hooks: EditorHooks;

  constructor(parent: HTMLElement, hooks: EditorHooks) {
    this.hooks = hooks;
    this.view = new EditorView({ parent, extensions: extensions(hooks) });
    this.setEnabled(false);
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  /**
   * Show a different file.
   *
   * A whole new state rather than a change to the existing one, so that undo
   * cannot walk backwards out of this file and into the last one — which
   * would silently paste one robot's code into another.
   */
  show(content: string): void {
    this.view.setState(EditorState.create({ doc: content, extensions: extensions(this.hooks) }));
    this.setEnabled(true);
  }

  setEnabled(enabled: boolean): void {
    this.view.contentDOM.setAttribute('contenteditable', String(enabled));
    this.view.dom.style.opacity = enabled ? '1' : '0.4';
  }

  focus(): void {
    this.view.focus();
  }
}
