/**
 * The guide (criterion `O01`) — what this app does, and how to use it.
 *
 * **It is not the help page.** Help (`D02`) is the two registries printed: every command, every
 * chord, alphabetised. That answers "which key does this" and answers nothing else. The guide
 * answers the question someone actually arrives with — *what is this for, and how do I do it* —
 * so it is written as chapters in the order a researcher meets the app, each one a short account
 * of what the app does there, the steps to do it, and a picture that moves where a picture that
 * moves says it better than a sentence would.
 *
 * ## Why this file is a table of *ids*
 *
 * The same discipline as `menus.ts`, for the same reason. A chapter names commands by id and
 * panel controls by id; every word it *displays* about a command — the title, the category, the
 * chord beside it — is read back out of the command and keybinding registries when the page
 * draws. A guide that spelled out its own titles would be a third authority after the registries
 * and the menus, and the first time a command was renamed it would be a confidently wrong
 * manual. So the chapters own only the two things no registry can hold: which features belong
 * together, and how you use them.
 *
 * ## How the guide is kept from rotting
 *
 * From milestone 6 on, a feature is not done until the guide shows it. That is a process rule,
 * and process rules decay, so it is made mechanical in three tiers:
 *
 * 1. **Commands.** `guideCoverage` is computed against the live `CommandRegistry`, not against a
 *    copy. Every registered command must be named by some chapter. A command with no chapter is
 *    `missing`, which fails `guide.test.ts` *and* is drawn on the page itself under "not yet in
 *    the guide" — so the failure is visible to whoever is looking at the app as well as to CI.
 *    The reverse also holds: a chapter naming a command nobody registered is `unknown`.
 * 2. **Panel controls.** Not everything the app can do is a command: the graph's filter, the
 *    saved page's zoom lever, the discard and delete controls on the shelf are *panel* controls,
 *    deliberately — they act on the panel in front of you rather than on the workspace, so
 *    nothing would be gained by putting them on the global registry. Those are `PANEL_CONTROLS`
 *    here, and the panel that draws each one carries `data-control="<id>"` on it. A test scans
 *    the renderer's own source and insists the two sets are equal in *both* directions, so a
 *    registered control that has lost its widget and a widget whose id was never registered both
 *    fail — and a control cannot be registered without a chapter covering it.
 * 3. **Context menus.** Every `ContextMenuKind` must be covered, so the right hand (`R01`) is
 *    taught rather than discovered.
 *
 * What is deliberately *not* mechanised: the prose. A chapter's lede and steps are the one part
 * of this that a person has to write, and no test can tell whether they are true. Keeping them
 * short is the mitigation — a paragraph and a handful of steps per chapter, not a manual.
 *
 * ## Motion
 *
 * Every chapter names one `GuideMotion`. The renderer draws it as an inline SVG animated with
 * CSS keyframes it ships itself — no CDN, no animation library, no video, nothing fetched. The
 * artwork is legible at rest, because `prefers-reduced-motion: reduce` stops all of it.
 */
import { COMMAND_IDS, type CommandId } from './command-ids.js';
import type { RegisteredCommand } from './commands.js';
import type { ContextMenuKind } from './menus.js';

// ---------------------------------------------------------------------------
// Panel controls: the features that are not commands
// ---------------------------------------------------------------------------

/**
 * A thing the researcher does that lives on a panel rather than on the command registry.
 *
 * The bar for being here is that it is a *feature* — something the researcher chooses to do,
 * that a guide would be incomplete without — and not a widget of a flow some command already
 * covers. The search box inside the search page is not here (`Search Library` is the feature);
 * the graph's filter is, because nothing else in the app can do what it does.
 */
export const PANEL_CONTROL_IDS = {
  markSentence: 'reader.highlight',
  savedPageZoom: 'snapshot.zoom',
  addLocalFiles: 'library.addFiles',
  zoteroScope: 'library.zoteroScope',
  notesFolder: 'notes.folder',
  newNotebook: 'notebook.new',
  notebookDesk: 'notebook.desk',
  notebookExcerpt: 'notebook.excerpt',
  notebookOutline: 'notebook.outline',
  notebookClaim: 'notebook.claim',
  notebookDiscard: 'notebook.discard',
  notebookDelete: 'notebook.delete',
  blockPicture: 'block.picture',
  journalCalendar: 'journal.calendar',
  graphFind: 'graph.find',
  graphHops: 'graph.hops',
  graphSpacing: 'graph.spacing',
  graphLabels: 'graph.labels',
  graphReset: 'graph.reset',
  graphRename: 'graph.rename',
  graphPicture: 'graph.picture',
  wikiSize: 'wiki.size',
  librarianConsent: 'librarian.consent',
  librarianRun: 'librarian.run',
  librarianProposals: 'librarian.proposals',
} as const;

export type PanelControlId = (typeof PANEL_CONTROL_IDS)[keyof typeof PANEL_CONTROL_IDS];

export interface PanelControl {
  readonly id: PanelControlId;
  /** What it is called, in the guide's voice. The widget's own label may be shorter. */
  readonly title: string;
  /** Where the researcher will find it — a surface, named the way the app names it. */
  readonly surface: string;
  /** What it does, in one sentence. */
  readonly hint: string;
}

/**
 * Every panel control, with the surface it is on.
 *
 * Kept in the order a researcher meets them rather than alphabetically, so that reading this
 * list top to bottom is itself a tour. The renderer's own source is checked against it in both
 * directions — see the file header.
 */
export const PANEL_CONTROLS: readonly PanelControl[] = [
  {
    id: PANEL_CONTROL_IDS.zoteroScope,
    title: 'Choose what comes over from Zotero',
    surface: 'Library sidebar',
    hint: 'Pick the collections to import. Your Zotero library is only ever read, never written to.',
  },
  {
    id: PANEL_CONTROL_IDS.addLocalFiles,
    title: 'Add files from this Mac',
    surface: 'Library sidebar',
    hint: 'A PDF, a saved page or a markdown file that never came from Zotero can be dropped in beside the ones that did.',
  },
  {
    id: PANEL_CONTROL_IDS.notesFolder,
    title: 'Choose where notes are written',
    surface: 'Library sidebar',
    hint: 'Notes are markdown files in a folder you pick, readable without this app.',
  },
  {
    id: PANEL_CONTROL_IDS.savedPageZoom,
    title: 'The saved page’s zoom lever',
    surface: 'A saved web page',
    hint: 'An archived page keeps the layout it was captured at; the lever scales it so it stays readable in half a window.',
  },
  {
    id: PANEL_CONTROL_IDS.markSentence,
    title: 'Mark a sentence',
    surface: 'Any reader',
    hint: 'Select text and press Highlight. The mark is anchored to the words, so it survives the file being re-extracted.',
  },
  {
    id: PANEL_CONTROL_IDS.newNotebook,
    title: 'Start a notebook',
    surface: 'Notebooks sidebar, and the directory',
    hint: 'A notebook is a question you are working on and the paper you are writing about it.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookDesk,
    title: 'Put something on the desk',
    surface: 'A notebook’s page',
    hint: 'The desk is what this notebook is built from — the files and marked sentences it draws on.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookExcerpt,
    title: 'Quote a highlight into the page',
    surface: 'A notebook’s page',
    hint: 'The marked sentence arrives as a blockquote that still links back to where you read it.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookOutline,
    title: 'Go to a section of the paper',
    surface: 'A notebook’s page',
    hint: 'The margin lists the page’s own headings in order; click one and the writing scrolls to it.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookClaim,
    title: 'Write a claim',
    surface: 'A notebook’s page',
    hint: 'A claim is a hypothesis you can attach evidence to, for and against.',
  },
  {
    id: PANEL_CONTROL_IDS.blockPicture,
    title: 'Drop a picture into a block',
    surface: 'Any writing surface',
    hint: 'There is no button, because the bytes have to come from the operating system: drag the image onto the blocks and it is copied in beside the text.',
  },
  {
    id: PANEL_CONTROL_IDS.journalCalendar,
    title: 'The month, every day of it',
    surface: 'A notebook’s journal',
    hint: 'Every day is drawn, written or not; the ones with an entry are marked, and clicking one goes there.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookDiscard,
    title: 'Set a notebook aside',
    surface: 'Notebooks sidebar',
    hint: 'Discarding asks for a reason and moves the notebook to the shelf below. Nothing is lost and it comes back.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookDelete,
    title: 'Delete a discarded notebook for good',
    surface: 'Notebooks sidebar, on the discarded shelf only',
    hint: 'Offered only after it has been set aside, and only behind a confirmation that says what goes with it.',
  },
  {
    id: PANEL_CONTROL_IDS.graphFind,
    title: 'Find something on the map',
    surface: 'Every graph surface',
    hint: 'Type a title, or words you marked. What does not match dims, and the view pans to what does.',
  },
  {
    id: PANEL_CONTROL_IDS.graphHops,
    title: 'How far the map reaches',
    surface: 'A file’s link graph',
    hint: 'One hop is what this file touches; three is the neighbourhood around it.',
  },
  {
    id: PANEL_CONTROL_IDS.graphSpacing,
    title: 'How far apart the discs sit',
    surface: 'A file’s link graph',
    hint: 'Spread a crowded graph out until the labels stop colliding.',
  },
  {
    id: PANEL_CONTROL_IDS.graphLabels,
    title: 'Names on or off',
    surface: 'Graph surfaces',
    hint: 'Turn the titles off to see the shape of the graph rather than its contents.',
  },
  {
    id: PANEL_CONTROL_IDS.graphReset,
    title: 'Back to the resting view',
    surface: 'Graph surfaces',
    hint: 'Undo every pan and zoom in one press. A graph is easy to get lost in.',
  },
  {
    id: PANEL_CONTROL_IDS.graphRename,
    title: 'Rename a node',
    surface: 'A file’s link graph',
    hint: 'What a paper is called on your map. Zotero goes on calling it what it calls it.',
  },
  {
    id: PANEL_CONTROL_IDS.graphPicture,
    title: 'Give a node a picture',
    surface: 'A file’s link graph',
    hint: 'A disc can wear a figure from your own library, so the map is recognisable at a glance.',
  },
  {
    id: PANEL_CONTROL_IDS.wikiSize,
    title: 'How much of the map is drawn',
    surface: 'The wiki',
    hint: 'A cap on how many nodes are laid out. Anything left off is counted in the header.',
  },
  {
    id: PANEL_CONTROL_IDS.librarianConsent,
    title: 'Turn the librarian on',
    surface: 'Librarian sidebar',
    hint: 'Off until you switch it on, and it tells you exactly what it would send before you do.',
  },
  {
    id: PANEL_CONTROL_IDS.librarianRun,
    title: 'Ask the librarian to look',
    surface: 'Librarian sidebar',
    hint: 'It reads what is in the library and comes back with links it thinks are there.',
  },
  {
    id: PANEL_CONTROL_IDS.librarianProposals,
    title: 'Accept or refuse a proposal',
    surface: 'Librarian sidebar',
    hint: 'Nothing it proposes becomes a link until you say so — and everything it can do, you can do by hand.',
  },
];

const CONTROLS_BY_ID: ReadonlyMap<string, PanelControl> = new Map(
  PANEL_CONTROLS.map((control) => [control.id, control]),
);

export function panelControl(id: PanelControlId): PanelControl {
  const found = CONTROLS_BY_ID.get(id);
  if (found === undefined) throw new Error(`no panel control registered with id \`${id}\``);
  return found;
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

/**
 * The pictures the guide can draw, by name.
 *
 * A closed set rather than a free string so a chapter cannot ask for artwork nobody drew — the
 * renderer has one CSS keyframe set per name and the test asserts the two agree.
 */
export const GUIDE_MOTIONS = [
  'shelf',
  'read',
  'mark',
  'search',
  'link',
  'retrace',
  'map',
  'note',
  'blocks',
  'desk',
  'calendar',
  'aside',
  'propose',
  'keys',
] as const;
export type GuideMotion = (typeof GUIDE_MOTIONS)[number];

export interface GuideStep {
  /** One instruction, in the imperative. Short enough to follow without re-reading. */
  readonly text: string;
  /**
   * The command this step runs, when it is one. The page prints its chord beside the step,
   * read from the keybinding registry — so a step is also how a key is learned, and can never
   * print a chord that has moved.
   */
  readonly commandId?: CommandId;
}

export interface GuideChapter {
  readonly id: string;
  readonly title: string;
  /** What the app does here, in a sentence or two. Not what the buttons are called. */
  readonly lede: string;
  readonly motion: GuideMotion;
  /** What the moving picture is showing, for anyone who cannot see it move. */
  readonly motionCaption: string;
  readonly steps: readonly GuideStep[];
  readonly commands: readonly CommandId[];
  readonly controls: readonly PanelControlId[];
  readonly menus: readonly ContextMenuKind[];
}

const C = COMMAND_IDS;
const P = PANEL_CONTROL_IDS;

/**
 * The guide, in the order a researcher meets the app.
 *
 * Every chapter is the same shape: what this part of the app is *for*, a picture of it working,
 * and the steps. The order is a claim — you import before you read, you read before you mark,
 * you mark before any of it becomes structure — and it is the reason this is a written table
 * rather than a grouping of `commands.all()` by category. Category is what a command is about;
 * a chapter is when you would want it.
 */
export const GUIDE_CHAPTERS: readonly GuideChapter[] = [
  {
    id: 'library',
    title: 'The library is your Zotero library',
    lede:
      'Nothing is uploaded and nothing is copied out of Zotero. This app reads your library through Zotero’s own local API, mints its own ids for what it finds, and remembers the Zotero key beside them. Your `zotero.sqlite` is never written to. Files that never came from Zotero — a PDF on your disk, a page you saved, a folder of markdown — sit in the same library beside the ones that did.',
    motion: 'shelf',
    motionCaption: 'Items arriving from Zotero and settling into the library list.',
    steps: [
      { text: 'Open the library sidebar.', commandId: C.toggleLibrarySidebar },
      { text: 'Choose the Zotero collections to bring over, then import. Run it again later and only what is new is added.' },
      { text: 'Drop a local PDF, saved page or markdown file onto the library to add it without Zotero.' },
      { text: 'Point the notes folder at a directory you own; notes are written there as plain markdown.' },
      { text: 'Lost track of what you are reading? Show it where it lives on the shelf.', commandId: C.revealInLibrary },
    ],
    commands: [C.toggleLibrarySidebar, C.revealInLibrary],
    controls: [P.zoteroScope, P.addLocalFiles, P.notesFolder],
    menus: [],
  },
  {
    id: 'read',
    title: 'Read the document, not a transcription of it',
    lede:
      'A PDF opens as a PDF, a saved web page opens as the page that was saved, and markdown opens rendered. Extracted text exists — search and highlight anchors are built on it — but it is never what you are shown, and never a silent fallback when rendering is hard. Two panels side by side is the shape this workspace is built for.',
    motion: 'read',
    motionCaption: 'A document opening, then a second one taking the space beside it.',
    steps: [
      { text: 'Open a file by typing part of its title.', commandId: C.goToFile },
      { text: 'Open the second one beside the first instead of over it.', commandId: C.openToSide },
      { text: 'Split the panel you are in when you want the same file twice.', commandId: C.splitCurrentPanel },
      { text: 'A saved page is laid out at the width it was captured at. Use its zoom lever when the panel is narrower than that.' },
      { text: 'Close the tab, or the whole group.', commandId: C.closeTab },
      { text: 'Wherever you have wandered to, go back to what you were reading.', commandId: C.openReading },
    ],
    commands: [
      C.openDocument,
      C.openDocumentAtLocation,
      C.goToFile,
      C.openReading,
      C.openToSide,
      C.splitCurrentPanel,
      C.closeTab,
      C.closeGroup,
    ],
    controls: [P.savedPageZoom],
    menus: ['library-row', 'tab', 'reader'],
  },
  {
    id: 'mark',
    title: 'Mark the sentences that matter',
    lede:
      'A highlight is the unit everything else is built from. It is anchored to the words themselves — the exact text, what comes before it and what comes after, and hashes of all three — not to a rectangle on a page, so it survives the file being re-extracted, re-flowed or reopened on another day.',
    motion: 'mark',
    motionCaption: 'A sentence being selected, and the mark settling over it.',
    steps: [
      { text: 'Select the text and press Highlight. It works the same in all three readers.' },
      { text: 'Open the sidebar that lists every mark in this file.', commandId: C.toggleAnnotationSidebar },
      { text: 'Click one to go back to the page and paragraph it came from.', commandId: C.openAnnotation },
      { text: 'Right-click a highlight for everything that can be done with it.' },
    ],
    commands: [C.openAnnotation, C.toggleAnnotationSidebar],
    controls: [P.markSentence],
    menus: ['highlight'],
  },
  {
    id: 'search',
    title: 'Search finds the sentence, and takes you to it',
    lede:
      'The index is full-text over the extracted text of everything in the library, chunked so a result is a passage rather than a file. A result carries the location it was found at, so opening it lands on the page and scrolls to the words — the point of searching is not the list.',
    motion: 'search',
    motionCaption: 'A query typed, passages appearing, and one of them opening at its own location.',
    steps: [
      { text: 'Open search.', commandId: C.openSearch },
      { text: 'Type words that were in the text, not the title.' },
      { text: 'Open a result: the reader goes to that passage, not to the top of the file.' },
    ],
    commands: [C.openSearch],
    controls: [],
    menus: [],
  },
  {
    id: 'link',
    title: 'Link one thing to another, and say what kind of link it is',
    lede:
      'Every relationship in this app is a typed, directed edge: this paper cites that one, this sentence supports that claim, this note is about that file. There is no untyped “related items” bucket, which is what makes the questions below answerable — a file’s ledger can tell you what links to it, what it links to, and what kind of connection each one is.',
    motion: 'link',
    motionCaption: 'A line drawing itself between two nodes, with its type appearing on it.',
    steps: [
      { text: 'With a file or a highlight in front of you, start a link and pick the other end.', commandId: C.linkToDocument },
      { text: 'Choose the relationship. A claim as the target offers supports and opposes.', commandId: C.createDocumentLink },
      { text: 'Open the file’s ledger: every link on it, and on every sentence marked in it.', commandId: C.openLedger },
      { text: 'Find everything that refers to what you are on.', commandId: C.findAllReferences },
      { text: 'Step through those references without leaving the reader.', commandId: C.goToNextReference },
      { text: 'Copy a link to this exact place, to paste into a note or a notebook.', commandId: C.copyInternalLink },
    ],
    commands: [
      C.linkToDocument,
      C.createDocumentLink,
      C.copyInternalLink,
      C.openLedger,
      C.findAllReferences,
      C.findIncomingLinks,
      C.findOutgoingLinks,
      C.findAllLinksOfType,
      C.openBacklinks,
      C.goToNextReference,
      C.goToPreviousReference,
    ],
    controls: [],
    menus: [],
  },
  {
    id: 'retrace',
    title: 'Follow a link, and find your way back',
    lede:
      'Links inside documents behave the way they do in a code editor: the pointer over one, a key, and you are there — or a peek, which shows you the target without moving you. Everywhere you have been is a history you can walk in both directions, and anything that is part of something larger knows what it is part of.',
    motion: 'retrace',
    motionCaption: 'A step forward along a trail of documents, then back along the same trail.',
    steps: [
      { text: 'Follow the link under the pointer.', commandId: C.goToTarget },
      { text: 'Or look at where it goes without leaving this page.', commandId: C.peekDefinition },
      { text: 'Go up to the thing this is part of — a highlight’s file, a note’s source.', commandId: C.goToParent },
      { text: 'Walk your own trail backwards, and forwards again.', commandId: C.goBack },
    ],
    commands: [
      C.goToTarget,
      C.goToDefinition,
      C.peekDefinition,
      C.goToParent,
      C.goToSource,
      C.goBack,
      C.goForward,
    ],
    controls: [],
    menus: [],
  },
  {
    id: 'map',
    title: 'The graph is how you get somewhere',
    lede:
      'Three views of the same edges. The wiki is the whole library at once — files, notes and the sentences you marked, each highlight carrying a few words of itself so you can tell it from a paper. The focused view puts one file in the middle and crawls: pick something at the edge and it becomes the middle. A file’s link graph is its own neighbourhood, as many hops out as you ask for. None of them is a picture to admire — clicking a disc opens the thing.',
    motion: 'map',
    motionCaption: 'A filter typed into a crowded graph: what does not match dims, and the view pans to what does.',
    steps: [
      { text: 'Open the wiki — everything, and everything between.', commandId: C.openWiki },
      { text: 'Put one file in the middle and crawl outwards from it.', commandId: C.openFocusView },
      { text: 'Or look at just this file’s neighbourhood.', commandId: C.openLinkGraph },
      { text: 'Type in Find to search the map in place: non-matches dim and the view moves to the match.' },
      { text: 'Give a node your own name and a picture from your library, so the map is recognisable.' },
      { text: 'Right-click a disc for the same actions its row in the library offers.' },
    ],
    commands: [C.openWiki, C.openFocusView, C.openLinkGraph],
    controls: [
      P.graphFind,
      P.graphHops,
      P.graphSpacing,
      P.graphLabels,
      P.graphReset,
      P.graphRename,
      P.graphPicture,
      P.wikiSize,
    ],
    menus: ['graph-node'],
  },
  {
    id: 'notes',
    title: 'A note is a file you own',
    lede:
      'Notes are markdown in the folder you chose, not rows in a database you cannot read without this app. A note made from what you are reading is linked to it from the moment it exists, so the connection is not something you have to remember to make.',
    motion: 'note',
    motionCaption: 'A note sliding out of the page it was made from, still tied to it.',
    steps: [
      { text: 'Make a note from the file or the highlight in front of you; the link is made with it.', commandId: C.newNoteFromHere },
      { text: 'Open an existing note.', commandId: C.openNote },
      { text: 'Write `[[wikilinks]]` in it — they resolve, and they are real edges like any other.' },
    ],
    commands: [C.newNoteFromHere, C.openNote],
    controls: [],
    menus: [],
  },
  {
    id: 'notebook',
    title: 'A notebook is where the paper gets written',
    lede:
      'A notebook is a question you are working on, and the page under it is meant to hold a full publishable paper: blocks of markdown, code, images, LaTeX inline and displayed, claims with evidence for and against, and excerpts that keep their link to the sentence they came from. The page takes the room — everything else on the notebook is margin.',
    motion: 'blocks',
    motionCaption: 'Blocks being added to a page: prose, a code block, and a formula setting itself.',
    steps: [
      { text: 'Open the directory of every notebook you have.', commandId: C.openNotebookDirectory },
      { text: 'Start one, then open its page.', commandId: C.openNotebook },
      { text: 'Add a block of prose, or one of code.', commandId: C.addTextBlock },
      { text: 'Click into a block to edit it — the caret lands where you clicked.', commandId: C.editBlock },
      { text: 'Write `$x^2$` inline or `$$…$$` on its own line; the maths is typeset here, from code that ships with the app.' },
      { text: 'Drag an image onto the blocks to put a figure in.' },
      { text: 'Quote a highlight in as an excerpt: it arrives as a blockquote that still links back to the paper.' },
      { text: 'Write a claim, and attach evidence to it for or against.' },
      { text: 'Right-click a block to add another one directly beneath it.' },
      { text: 'Sections in the margin is the page’s own outline: click a heading to go to it.' },
      { text: 'The notebooks sidebar is the shelf of what you are working on.', commandId: C.toggleQuestionsSidebar },
    ],
    commands: [
      C.openNotebook,
      C.openNotebookDirectory,
      C.editBlock,
      C.addTextBlock,
      C.addCodeBlock,
      C.toggleQuestionsSidebar,
    ],
    controls: [
      P.newNotebook,
      P.notebookDesk,
      P.notebookExcerpt,
      P.notebookOutline,
      P.notebookClaim,
      P.blockPicture,
    ],
    menus: ['notebook', 'block'],
  },
  {
    id: 'send',
    title: 'Reading flows into a notebook',
    lede:
      'The gesture that closes the loop. Sending sits beside Link and Note in every reader, takes a marked sentence as readily as a whole file, and lands it as a card on that notebook’s desk — which is a real typed edge, not a bookmark. It is the same command wherever you run it from: the reader’s strip, a right-click, or the key.',
    motion: 'desk',
    motionCaption: 'A marked sentence lifting off the page and landing as a card on a notebook’s desk.',
    steps: [
      { text: 'Mark a sentence, or just have the file open.' },
      { text: 'Send it, and pick which notebook.', commandId: C.sendToNotebook },
      { text: 'It is on that notebook’s desk, and the desk says which file it came from.' },
    ],
    commands: [C.sendToNotebook],
    controls: [],
    menus: [],
  },
  {
    id: 'journal',
    title: 'The journal is the day book',
    lede:
      'Every notebook has a log attached to it. The journal is the small end of the writing — what you did today, what did not work, a thought to pick up tomorrow — while the notebook page is the paper. Same blocks, different job. The calendar draws every day of the month, written or not, so a gap looks like a gap rather than a control that failed.',
    motion: 'calendar',
    motionCaption: 'A month drawn day by day, the written ones filling in.',
    steps: [
      { text: 'Open this notebook’s journal.', commandId: C.openJournal },
      { text: 'Write into today. It opens on today, always.' },
      { text: 'Click any day in the calendar to read or write that one.' },
      { text: 'Set the date the journal begins; the calendar starts there.' },
    ],
    commands: [C.openJournal],
    controls: [P.journalCalendar],
    menus: [],
  },
  {
    id: 'aside',
    title: 'Ideas live and die differently',
    lede:
      'Most questions do not get answered; they get set aside. Discarding one asks what happened and moves it to a shelf below the working ones, with everything intact — it comes back whenever you want it. Deleting is a different act entirely: offered only on that shelf, only behind a confirmation, and it takes the notebook’s journal, its claims and its desk with it. The papers and highlights they pointed at stay in the library.',
    motion: 'aside',
    motionCaption: 'A notebook sliding down to the shelf below, and being lifted back up again.',
    steps: [
      { text: 'On the notebooks sidebar, discard the one you are done with and say why.' },
      { text: 'It is on the discarded shelf, with your reason on it. Restore puts it straight back.' },
      { text: 'Delete is only ever offered there, and only after a confirmation that says what goes.' },
    ],
    commands: [],
    controls: [P.notebookDiscard, P.notebookDelete],
    menus: [],
  },
  {
    id: 'librarian',
    title: 'The librarian proposes; you decide',
    lede:
      'An optional assistant that reads what is already in your library and suggests links it thinks are there. It is off until you turn it on, it tells you exactly what it would send and what it withholds before you do, and nothing it finds becomes a link until you accept it. Everything the librarian can do, you can do by hand — that is the rule it is built under, not a limitation of it.',
    motion: 'propose',
    motionCaption: 'A dashed proposal appearing between two nodes and becoming a solid link when it is accepted.',
    steps: [
      { text: 'Open the librarian.', commandId: C.toggleLibrarianSidebar },
      { text: 'Read the disclosure — what leaves this machine, and what never does — then switch it on.' },
      { text: 'Ask it to look. It works in the background and reports as it goes.' },
      { text: 'Go through the proposals one at a time. Accept makes the link; refuse makes nothing.' },
    ],
    commands: [C.toggleLibrarianSidebar],
    controls: [P.librarianConsent, P.librarianRun, P.librarianProposals],
    menus: [],
  },
  {
    id: 'lost',
    title: 'When you cannot remember how',
    lede:
      'Three doors, and none of them needs you to already know a key. The command list is everything the app can do, searchable by what you would call it. Help is the same registry printed with its chords, so it can never disagree with what the keys actually do. This guide is where to come back to when the question is “what does this do” rather than “which key”.',
    motion: 'keys',
    motionCaption: 'A chord being pressed, and the page it opens arriving.',
    steps: [
      { text: 'Every action, by name, wherever you are.', commandId: C.showCommands },
      { text: 'Every key, grouped by what its modifiers mean.', commandId: C.openHelp },
      { text: 'This page.', commandId: C.openGuide },
      { text: 'Or right-click the thing itself: a menu is this same registry, read where the pointer is.' },
    ],
    commands: [C.showCommands, C.openHelp, C.openGuide],
    controls: [],
    menus: [],
  },
];

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface GuideCoverage {
  /** Registered command ids some chapter names. */
  readonly covered: readonly string[];
  /** Registered command ids no chapter names. Must be empty; drawn on the page if it is not. */
  readonly missing: readonly RegisteredCommand[];
  /** Command ids a chapter names that no registry has. A typo, or a command that was removed. */
  readonly unknown: readonly string[];
  /** Panel controls no chapter covers. */
  readonly missingControls: readonly PanelControlId[];
  /** Context-menu surfaces no chapter covers. */
  readonly missingMenus: readonly ContextMenuKind[];
  /** True when the guide accounts for everything the registries hold. */
  readonly complete: boolean;
}

/**
 * What the guide covers, measured against the registry it is handed.
 *
 * Takes the commands rather than reaching for a module-level table, because the registry is the
 * thing that can change under it: the app's own is the built-in table plus anything else
 * registered on this window, and that — not `COMMAND_IDS` — is the authority the criterion means
 * by "every feature the registries know".
 */
export function guideCoverage(
  commands: readonly RegisteredCommand[],
  chapters: readonly GuideChapter[] = GUIDE_CHAPTERS,
  menuKinds: readonly ContextMenuKind[] = [],
): GuideCoverage {
  const claimed = new Set<string>();
  const claimedControls = new Set<string>();
  const claimedMenus = new Set<string>();
  for (const chapter of chapters) {
    for (const id of chapter.commands) claimed.add(id);
    for (const id of chapter.controls) claimedControls.add(id);
    for (const kind of chapter.menus) claimedMenus.add(kind);
  }

  const registered = new Set(commands.map((command) => command.id));
  const covered: string[] = [];
  const missing: RegisteredCommand[] = [];
  for (const command of commands) {
    if (claimed.has(command.id)) covered.push(command.id);
    else missing.push(command);
  }
  const unknown = [...claimed].filter((id) => !registered.has(id));
  const missingControls = PANEL_CONTROLS.map((control) => control.id).filter(
    (id) => !claimedControls.has(id),
  );
  const missingMenus = menuKinds.filter((kind) => !claimedMenus.has(kind));

  return {
    covered,
    missing,
    unknown,
    missingControls,
    missingMenus,
    complete:
      missing.length === 0 &&
      unknown.length === 0 &&
      missingControls.length === 0 &&
      missingMenus.length === 0,
  };
}
