/**
 * Every command the application registers, by id.
 *
 * Its own module so that two things can name a command without one of them having to import
 * the whole workbench: `menus.ts` builds the context menus out of these ids and `workbench.ts`
 * defines the commands they resolve to, and a table in either that imported the other would be
 * a cycle whose losing side evaluates to `undefined` at load time.
 *
 * The ids are the app's vocabulary of actions. Nothing offers an action that is not one of
 * these — a toolbar button, a keystroke, the palette and a right-click menu all name a command
 * here — which is what keeps the help page (`D02`) an exhaustive account of what the app does.
 */
export const COMMAND_IDS = {
  openDocument: 'wr.openDocument',
  openDocumentAtLocation: 'wr.openDocumentAtLocation',
  openAnnotation: 'wr.openAnnotation',
  openNote: 'wr.openNote',
  openSearch: 'wr.openSearch',
  openToSide: 'wr.openToSide',
  splitCurrentPanel: 'wr.splitCurrentPanel',
  closeTab: 'wr.closeTab',
  closeGroup: 'wr.closeGroup',
  toggleLibrarySidebar: 'wr.toggleLibrarySidebar',
  toggleQuestionsSidebar: 'wr.toggleQuestionsSidebar',
  openJournal: 'wr.openJournal',
  expandJournal: 'wr.expandJournal',
  openLibrarian: 'wr.openLibrarian',
  toggleAnnotationSidebar: 'wr.toggleAnnotationSidebar',
  goToTarget: 'wr.goToTarget',
  goToDefinition: 'wr.goToDefinition',
  peekDefinition: 'wr.peekDefinition',
  goToParent: 'wr.goToParent',
  goToSource: 'wr.goToSource',
  findAllReferences: 'wr.findAllReferences',
  findAllLinksOfType: 'wr.findAllLinksOfType',
  findIncomingLinks: 'wr.findIncomingLinks',
  findOutgoingLinks: 'wr.findOutgoingLinks',
  openBacklinks: 'wr.openBacklinks',
  openLinkGraph: 'wr.openLinkGraph',
  openWiki: 'wr.openWiki',
  openFocusView: 'wr.openFocusView',
  openLedger: 'wr.openLedger',
  openNotebook: 'wr.openNotebook',
  openNotebookDirectory: 'wr.openNotebookDirectory',
  openHelp: 'wr.openHelp',
  openGuide: 'wr.openGuide',
  goToFile: 'wr.goToFile',
  openReading: 'wr.openReading',
  goBack: 'wr.goBack',
  goForward: 'wr.goForward',
  goToNextReference: 'wr.goToNextReference',
  goToPreviousReference: 'wr.goToPreviousReference',
  copyInternalLink: 'wr.copyInternalLink',
  revealInLibrary: 'wr.revealInLibrary',
  showCommands: 'wr.showCommands',
  linkToDocument: 'wr.linkToDocument',
  createDocumentLink: 'wr.createDocumentLink',
  deleteLink: 'wr.deleteLink',
  newNoteFromHere: 'wr.newNoteFromHere',
  sendToNotebook: 'wr.sendToNotebook',
  // Writing. A block is the unit both writing surfaces are made of — a journal day and a
  // notebook's page — and these are the things a researcher does to one that are not simply
  // typing into it (`R01`). `saveWriting` is about the whole surface rather than one block,
  // and it is here because that is where the surface lives (`P12`).
  editBlock: 'wr.editBlock',
  addTextBlock: 'wr.addTextBlock',
  addCodeBlock: 'wr.addCodeBlock',
  deleteBlock: 'wr.deleteBlock',
  saveWriting: 'wr.saveWriting',
  // Demo content (`B07`). Two commands rather than one toggle, because filling and clearing
  // are not the same act: one is a convenience and the other destroys rows, and a switch that
  // does either depending on state is a switch nobody can press deliberately.
  fillDemoLibrary: 'wr.fillDemoLibrary',
  clearDemoLibrary: 'wr.clearDemoLibrary',
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];
