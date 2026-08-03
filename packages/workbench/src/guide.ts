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
  notebookJump: 'notebook.jump',
  notebookFold: 'notebook.fold',
  notebookExcerpt: 'notebook.excerpt',
  notebookOutline: 'notebook.outline',
  notebookClaim: 'notebook.claim',
  notebookDiscard: 'notebook.discard',
  notebookDelete: 'notebook.delete',
  notebookEmptyBin: 'notebook.emptyBin',
  blockPicture: 'block.picture',
  // Typst's own three (`S05`, `S07`). None is a command: a header is text you edit in place
  // and the render's place is a preference, and neither is an action you run.
  notebookGlobalHeader: 'notebook.globalHeader',
  notebookLocalHeader: 'notebook.localHeader',
  notebookRenderPlacement: 'notebook.renderPlacement',
  blockRearrange: 'block.rearrange',
  blockResize: 'block.resize',
  journalCalendar: 'journal.calendar',
  linkDragHighlight: 'link.dragHighlight',
  linkDragNodes: 'link.dragNodes',
  graphFind: 'graph.find',
  graphHops: 'graph.hops',
  graphSpacing: 'graph.spacing',
  graphLabels: 'graph.labels',
  graphReset: 'graph.reset',
  graphRename: 'graph.rename',
  graphPicture: 'graph.picture',
  graphGallery: 'graph.gallery',
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
    surface: 'The library page',
    hint: 'Pick the collections to import. Your Zotero library is only ever read, never written to.',
  },
  {
    id: PANEL_CONTROL_IDS.addLocalFiles,
    title: 'Add files from this Mac',
    surface: 'The library page',
    hint: 'A PDF, a saved page or a markdown file that never came from Zotero can be dropped in beside the ones that did.',
  },
  {
    id: PANEL_CONTROL_IDS.notesFolder,
    title: 'Choose where notes are written',
    surface: 'The library page',
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
    surface: 'What next, and the directory',
    hint: 'A notebook is a question you are working on and the paper you are writing about it.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookJump,
    title: 'Go to a part of the page',
    surface: 'A notebook’s page',
    hint: 'Front matter, the outline, the writing and the claims are all sections of one document; this is where each of them begins.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookFold,
    title: 'Fold a section of the page',
    surface: 'A notebook’s page',
    hint: 'Front matter, the outline and the claims fold to their headings while you write, and the jump strip unfolds whichever one you go to.',
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
    hint: 'The page’s own headings in order; click one and the writing scrolls to it.',
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
    hint: 'Drag an image onto the blocks and it is added beside the text; new bytes have to come from the operating system, so dropping is how a picture that is not in the library yet gets in. One that already is comes back through + image.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookGlobalHeader,
    title: 'The header every notebook gets',
    surface: 'A notebook page, in the front matter',
    hint: 'Typst definitions shared by every paper you write — a command for a claim, a style for a figure. Saved when it compiles and refused when it does not, because a broken one would blank every page at once.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookLocalHeader,
    title: 'This notebook’s own header',
    surface: 'A notebook page, in the front matter',
    hint: 'What this paper adds on top. It is imported after the shared one, so a definition here quietly replaces the global one for this notebook and no other.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookRenderPlacement,
    title: 'Where the typeset page sits',
    surface: 'A notebook page, in the front matter',
    hint: 'A wide tab shows the typeset page beside the writing and a tall one beneath it; this moves the tall case above the writing instead, or turns the render off.',
  },
  {
    id: PANEL_CONTROL_IDS.blockRearrange,
    title: 'Move a block',
    surface: 'Any writing surface',
    hint: 'Every block has a grip beside it; drag it and the block goes where you put it. The order of the blocks is the order of the document, so nothing else has to be told.',
  },
  {
    id: PANEL_CONTROL_IDS.blockResize,
    title: 'Resize a figure',
    surface: 'Any writing surface',
    hint: 'Drag the corner of a picture to the size it should be. The width is written into the page’s own markdown, and the file itself is never touched.',
  },
  {
    id: PANEL_CONTROL_IDS.journalCalendar,
    title: 'The month, every day of it',
    surface: 'A notebook’s journal',
    hint: 'Every day is drawn, written or not; the ones with an entry are marked, and clicking one goes there.',
  },
  {
    id: PANEL_CONTROL_IDS.linkDragHighlight,
    title: 'Drag a marked sentence onto what is open beside it',
    surface: 'Any reader, and a notebook’s page',
    hint: 'Drag a highlight onto the paper beside it and the two are linked; drag it onto a notebook’s page and it lands there as an excerpt, quoted and still linked to the sentence it came from. No dialog in either case.',
  },
  {
    id: PANEL_CONTROL_IDS.linkDragNodes,
    title: 'Draw a link between two discs',
    surface: 'The wiki, and a file’s link graph',
    hint: 'Press on one node, drag to another and let go. A line follows the pointer while you drag, and letting go makes the link.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookDiscard,
    title: 'Set a notebook aside',
    surface: 'What next',
    hint: 'Discarding asks for a reason and moves the notebook to the shelf below. Nothing is lost and it comes back.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookDelete,
    title: 'Delete a discarded notebook',
    surface: 'What next, on the discarded shelf only',
    hint: 'Offered only after it has been set aside. Deleting moves the notebook to the bin below with everything it had; Put back returns it.',
  },
  {
    id: PANEL_CONTROL_IDS.notebookEmptyBin,
    title: 'Empty the bin',
    surface: 'What next, under the bin',
    hint: 'The one act in the app that destroys a line of work, so it is the one that asks first — and it says what goes and what stays in the library.',
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
    id: PANEL_CONTROL_IDS.graphGallery,
    title: 'Pick a picture from the gallery',
    surface: 'A file’s link graph, once card art is on',
    hint: 'A strip of illustrations to scroll through and press. It is the one part of this app that fetches anything, it says what it sends before you switch it on, every picture is kept here after the first time, and it asks for the artwork alone — never a whole card.',
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
    surface: 'The librarian, opened from the wiki',
    hint: 'Off until you switch it on, and it tells you exactly what it would send before you do.',
  },
  {
    id: PANEL_CONTROL_IDS.librarianRun,
    title: 'Ask the librarian to look',
    surface: 'The librarian, opened from the wiki',
    hint: 'It reads what is in the library and comes back with links it thinks are there.',
  },
  {
    id: PANEL_CONTROL_IDS.librarianProposals,
    title: 'Accept or refuse a proposal',
    surface: 'The librarian, opened from the wiki',
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
  'send',
  'calendar',
  'aside',
  'propose',
  'keys',
  'demo',
] as const;
export type GuideMotion = (typeof GUIDE_MOTIONS)[number];

// ---------------------------------------------------------------------------
// A picture per command (criterion `D03`)
// ---------------------------------------------------------------------------

/**
 * The pictures the *help* page can draw beside a command.
 *
 * The chapters' fourteen, plus four verbs a chapter never has to draw on its own because a
 * chapter is about a subject and a command is about an act: closing, unlinking, gathering and
 * saving. Everything else a command does is already one of the chapter drawings — `Open the
 * Wiki` and `Open the Focused View` really are the same picture of a map, and drawing two
 * near-identical maps to avoid saying so would be decoration rather than explanation.
 */
export const COMMAND_MOTIONS = [...GUIDE_MOTIONS, 'close', 'unlink', 'gather', 'save'] as const;
export type CommandMotion = (typeof COMMAND_MOTIONS)[number];

/**
 * The commands whose act is not the one its category would draw.
 *
 * A category says what a command is *about*; a picture has to show what it *does*, and the two
 * part company exactly where a category holds both halves of a pair — `Links` holds making an
 * edge and taking one away, `View` holds opening a page and closing one. Every id here is
 * checked against the registry by `commandMotionCoverage`, so a command that is renamed or
 * retired cannot leave a rule behind that silently stops applying.
 */
const MOTION_BY_COMMAND: Partial<Record<CommandId, CommandMotion>> = {
  [COMMAND_IDS.toggleLibrarySidebar]: 'shelf',
  [COMMAND_IDS.revealInLibrary]: 'shelf',
  [COMMAND_IDS.toggleQuestionsSidebar]: 'aside',
  [COMMAND_IDS.toggleAnnotationSidebar]: 'mark',
  [COMMAND_IDS.openLibrarian]: 'propose',
  [COMMAND_IDS.openSearch]: 'search',
  [COMMAND_IDS.goToFile]: 'search',
  [COMMAND_IDS.showCommands]: 'keys',
  [COMMAND_IDS.closeTab]: 'close',
  [COMMAND_IDS.closeGroup]: 'close',
  [COMMAND_IDS.splitCurrentPanel]: 'read',
  [COMMAND_IDS.openToSide]: 'read',
  [COMMAND_IDS.sendToNotebook]: 'send',
  [COMMAND_IDS.deleteLink]: 'unlink',
  [COMMAND_IDS.deleteBlock]: 'unlink',
  [COMMAND_IDS.saveWriting]: 'save',
  [COMMAND_IDS.findAllReferences]: 'gather',
  [COMMAND_IDS.findIncomingLinks]: 'gather',
  [COMMAND_IDS.findOutgoingLinks]: 'gather',
  [COMMAND_IDS.findAllLinksOfType]: 'gather',
  [COMMAND_IDS.openBacklinks]: 'gather',
  [COMMAND_IDS.openLedger]: 'gather',
  [COMMAND_IDS.goToNextReference]: 'retrace',
  [COMMAND_IDS.goToPreviousReference]: 'retrace',
};

/**
 * What each category draws when nothing more specific applies.
 *
 * Category is declared on every command, so this half of the rule is total by construction and
 * a command registered tomorrow has a picture without anybody remembering to give it one. That
 * is the whole reason the mapping is computed rather than written out per command: a
 * hand-written list of fifty-two would be a second registry, and the first command added
 * without a row in it would be a command the help page draws nothing for.
 */
const MOTION_BY_CATEGORY: Readonly<Record<string, CommandMotion>> = {
  Document: 'read',
  Annotations: 'mark',
  Notes: 'note',
  Search: 'search',
  Links: 'link',
  Navigation: 'retrace',
  Graph: 'map',
  Journal: 'calendar',
  Notebooks: 'blocks',
  Writing: 'blocks',
  View: 'keys',
  Demo: 'demo',
};

/** The last resort, so the function is total for a category nobody has drawn for yet. */
const FALLBACK_MOTION: CommandMotion = 'keys';

/**
 * The picture for one command (`D03`).
 *
 * Takes the two things every registered command declares. Total by construction — see
 * `MOTION_BY_CATEGORY` — because the help page draws one of these beside every row it has, and
 * a row with no picture is the failure the criterion names.
 */
export function commandMotion(command: {
  readonly id: string;
  readonly category: string;
}): CommandMotion {
  return (
    MOTION_BY_COMMAND[command.id as CommandId] ??
    MOTION_BY_CATEGORY[command.category] ??
    FALLBACK_MOTION
  );
}

export interface CommandMotionCoverage {
  /** Categories the registry holds that no rule names, so their commands fall back. */
  readonly uncoveredCategories: readonly string[];
  /** Ids `MOTION_BY_COMMAND` names that no registry has — a rename left behind. */
  readonly unknownCommands: readonly string[];
  readonly complete: boolean;
}

/**
 * Whether the mapping still fits the registry it is drawn against.
 *
 * The same discipline as `guideCoverage`, and for the same reason: the mapping is data about
 * commands, so it rots the moment a command moves and nothing checks. A category with no rule
 * is a failure rather than a shrug — the fallback exists so the *page* cannot break, not so
 * the table can be left incomplete.
 */
export function commandMotionCoverage(
  commands: readonly RegisteredCommand[],
): CommandMotionCoverage {
  const registered = new Set(commands.map((command) => command.id));
  const uncoveredCategories = [
    ...new Set(
      commands
        .filter((command) => MOTION_BY_COMMAND[command.id as CommandId] === undefined)
        .map((command) => command.category)
        .filter((category) => MOTION_BY_CATEGORY[category] === undefined),
    ),
  ];
  const unknownCommands = Object.keys(MOTION_BY_COMMAND).filter((id) => !registered.has(id));
  return {
    uncoveredCategories,
    unknownCommands,
    complete: uncoveredCategories.length === 0 && unknownCommands.length === 0,
  };
}

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
      { text: 'Open the library. It is a tab like everything else — press the same button again to put it away.', commandId: C.toggleLibrarySidebar },
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
      'A PDF opens as a PDF, a saved web page opens as the page that was saved, and markdown opens rendered. Extracted text exists — search and highlight anchors are built on it — but it is never what you are shown, and never a silent fallback when rendering is hard. Two panels side by side is the shape this workspace is built for, and nothing sits beside them: every surface in this app — the library, what next, the annotations list, the references — is a tab in the same workspace, dragged and split like any document, and put away by pressing the button that opened it.',
    motion: 'read',
    motionCaption: 'A document opening, then a second one taking the space beside it.',
    steps: [
      { text: 'Open a file by typing part of its title.', commandId: C.goToFile },
      { text: 'Open the second one beside the first instead of over it.', commandId: C.openToSide },
      { text: 'Split the panel you are in when you want the same file twice.', commandId: C.splitCurrentPanel },
      { text: 'A saved page is laid out at the width it was captured at. Use its zoom lever when the panel is narrower than that.' },
      { text: 'The list of marks in this file is a tab too. The bar opens it, and closes it again.', commandId: C.toggleAnnotationSidebar },
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
      C.toggleAnnotationSidebar,
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
      {
        text:
          'A saved page raises no bar — the archive runs no script and has no origin to speak' +
          ' from — so select the words and right-click them. The mark is painted onto the page' +
          ' itself, where the text is.',
      },
      { text: 'Open the page that lists every mark in this file.', commandId: C.toggleAnnotationSidebar },
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
      'The index is full-text over the extracted text of everything in the library, chunked so a result is a passage rather than a file. A result carries the location it was found at, so opening it lands on the page and scrolls to the words — the point of searching is not the list. Not everything it finds is a file: a marked sentence and a note are searched too, and each row goes to its own kind of place.',
    motion: 'search',
    motionCaption: 'A query typed, passages appearing, and one of them opening at its own location.',
    steps: [
      { text: 'Open search.', commandId: C.openSearch },
      { text: 'Type words that were in the text, not the title.' },
      { text: 'Click the result itself: a passage opens the file at that passage, a highlight opens it with the sentence marked, a note opens the note.' },
    ],
    commands: [C.openSearch],
    controls: [],
    menus: [],
  },
  {
    id: 'link',
    title: 'Link one thing to another — a link is just a link',
    lede:
      'Linking asks one question: what is the other end? Nothing asks what kind of connection it is, because in practice nobody wanted to be interrogated before two papers could be joined; the edge is written plainly and the table goes on holding a type for everything that reads one. Pick the other end from the library, from a map, or by dragging one thing onto another. The one thing still worth asking about is a claim: evidence either bears it out or tells against it, and that is which side it falls on rather than a kind of link.',
    motion: 'link',
    motionCaption: 'A line drawing itself between two nodes, and then being taken away again.',
    steps: [
      { text: 'With a file or a highlight in front of you, start a link and pick the other end.', commandId: C.linkToDocument },
      { text: 'Pick a file in the list and it opens out into the sentences marked in it — search them, or link the file itself if there are none.' },
      { text: 'That is the whole of it: no relationship to name.', commandId: C.createDocumentLink },
      { text: 'A claim is the exception: say whether the evidence supports it or opposes it.' },
      { text: 'Or skip the dialog: drag a highlight onto the paper open beside it, or drag between two discs on a map.' },
      { text: 'Open the file’s ledger: every link on it, and on every sentence marked in it.', commandId: C.openLedger },
      { text: 'Find everything that refers to what you are on.', commandId: C.findAllReferences },
      { text: 'Step through those references without leaving the reader.', commandId: C.goToNextReference },
      { text: 'Wrong link? Take it away from wherever you can see it — a ledger row, a references row, or the line itself on a map.', commandId: C.deleteLink },
      { text: 'Copy a link to this exact place, to paste into a note or a notebook.', commandId: C.copyInternalLink },
    ],
    commands: [
      C.linkToDocument,
      C.createDocumentLink,
      C.deleteLink,
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
    controls: [P.linkDragHighlight, P.linkDragNodes],
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
      'The wiki is one surface with two states. Whole, it is the library at once — files, notes and the sentences you marked, each highlight carrying enough of its own words to know what it is, laid out by force so that what is linked is drawn together and no two discs sit on top of each other. Focused, it puts one file in the middle and crawls: pick something at the edge and that becomes the middle, in the same tab. Focusing hides nothing — the rest of the library stays on screen, dimmed, and you can walk straight back out into it. A file’s link graph is a separate sidecar: its own neighbourhood, as many hops out as you ask for, beside what you are reading. Neither is a picture to admire — clicking a disc opens the thing. The wiki opens filling the page; drag its tab to a side and it keeps its scale, showing you less of the map rather than a smaller one.',
    motion: 'map',
    motionCaption: 'A filter typed into a crowded graph: what does not match dims, and the view pans to what does.',
    steps: [
      { text: 'Open the wiki — everything, and everything between. It fills the page.', commandId: C.openWiki },
      { text: 'Focus it on one file and crawl outwards from there; the same command again puts you back on the whole library.', commandId: C.openFocusView },
      { text: 'Focused, the library is still round you, only dimmer — click any of it to move the middle there.' },
      { text: 'Drag the wiki’s tab to the side of the workspace to keep it beside your reading. It keeps its scale — you see less of it, not a smaller version of it.' },
      { text: 'Or look at just this file’s neighbourhood, in a panel of its own.', commandId: C.openLinkGraph },
      { text: 'Type in Find to search the map in place: non-matches dim and the view moves to the match.' },
      { text: 'Give a node your own name and a picture from your library, so the map is recognisable.' },
      { text: 'Out of pictures? Turn card art on — read what it sends first — and pick an illustration from the gallery. Art only, kept here after the first time.' },
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
      P.graphGallery,
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
      'A notebook is a question you are working on, and the page under it is meant to hold a full publishable paper — so it is written in Typst, compiled by a copy of Typst that ships inside the app and never asks the network for anything. Blocks of prose, code, figures, mathematics, claims with evidence for and against, and excerpts that keep their link to the sentence they came from. It is one scrolling document: the front matter, the outline and the claims are sections of it, not a margin beside it.',
    motion: 'blocks',
    motionCaption: 'Blocks being added to a page: prose, a code block, and a formula setting itself.',
    steps: [
      { text: 'Open the directory of every notebook you have.', commandId: C.openNotebookDirectory },
      { text: 'Start one, then open its page.', commandId: C.openNotebook },
      { text: 'Add a block of prose, or one of code.', commandId: C.addTextBlock },
      { text: 'Click into a block to edit it — the caret lands where you clicked.', commandId: C.editBlock },
      { text: 'Write `$x^2$` inline or `$ … $` on its own line; the maths is typeset here, by the compiler that ships with the app.' },
      { text: 'Write `= Method` for a section and `#link("annotation://…")[…]` for a citation — the page is Typst, and it is the source you typed.' },
      { text: 'Add a picture the library already holds; a new one still arrives by being dropped on the page, and either can be dragged by its corner to the size it should be.', commandId: C.addImageBlock },
      { text: 'Quote a highlight in as an excerpt: it arrives as a quote that still links back to the paper.', commandId: C.addExcerptBlock },
      { text: 'Every insertion lands after the block you were last writing in, and at the end of the page when you have not written in one yet.' },
      { text: 'Define your own commands in the header every notebook shares, or in this notebook’s own — the local one is imported second, so it wins.' },
      { text: 'A wide tab shows the typeset page beside the writing, a tall one beneath it; the compiling happens elsewhere, so it never holds a keystroke.' },
      { text: 'Write a claim, and attach evidence to it for or against.' },
      { text: 'Right-click a block to add another one directly beneath it.' },
      { text: 'Drag the grip beside a block to move it; the order of the blocks is the order of the page.' },
      { text: 'Take a block out of the page altogether — the × beside it, or a right-click.', commandId: C.deleteBlock },
      { text: 'Blocks commit when you click away — or save the whole page whenever you like, without leaving the sentence you are on.', commandId: C.saveWriting },
      { text: 'Sections is the page’s own outline: click a heading to go to it.' },
      { text: 'Front matter, the outline, the writing and the claims are sections of one scrolling page; the strip under the title goes to each of them.' },
      { text: 'Fold a section by its heading while you write past it — the strip unfolds whichever one you go to.' },
      { text: 'What next is the short list of the work in front. It opens as a tab from the bar.', commandId: C.toggleQuestionsSidebar },
    ],
    commands: [
      C.openNotebook,
      C.openNotebookDirectory,
      C.editBlock,
      C.addTextBlock,
      C.addCodeBlock,
      C.addImageBlock,
      C.addExcerptBlock,
      C.deleteBlock,
      C.saveWriting,
      C.toggleQuestionsSidebar,
    ],
    controls: [
      P.newNotebook,
      P.notebookJump,
      P.notebookFold,
      P.notebookExcerpt,
      P.notebookOutline,
      P.notebookClaim,
      P.blockPicture,
      P.blockRearrange,
      P.blockResize,
      P.notebookGlobalHeader,
      P.notebookLocalHeader,
      P.notebookRenderPlacement,
    ],
    menus: ['notebook', 'block'],
  },
  {
    id: 'send',
    title: 'Reading flows into a notebook',
    lede:
      'The gesture that closes the loop. Sending sits beside Link and Note in every reader, takes a marked sentence as readily as a whole file, and lands it as a block in that notebook’s page — a highlight arrives as the sentence it marks, a paper as its name, and both keep a link back to where you read them. A real typed edge, not a bookmark. It is the same command wherever you run it from: the reader’s strip, a right-click, or the key.',
    motion: 'send',
    motionCaption: 'A marked sentence lifting off the page it was read on and landing as a block in a notebook.',
    steps: [
      { text: 'Mark a sentence, or just have the file open.' },
      { text: 'Send it, and pick which notebook.', commandId: C.sendToNotebook },
      { text: 'It is a block at the end of that notebook’s page, and the link on it goes back to what it came from.' },
      { text: 'Dropping a file straight onto the page does the same thing.' },
    ],
    commands: [C.sendToNotebook],
    controls: [],
    menus: [],
  },
  {
    id: 'journal',
    title: 'The journal is the day book',
    lede:
      'Every notebook has a log attached to it. The journal is the small end of the writing — what you did today, what did not work, a thought to pick up tomorrow — while the notebook page is the paper. Same blocks, different job. It comes up over what you are reading, because most visits to a journal are a glance; expand it into a page of the workspace when the day is worth sitting in. The calendar draws every day of the month, written or not, so a gap looks like a gap rather than a control that failed.',
    motion: 'calendar',
    motionCaption: 'A month drawn day by day, the written ones filling in.',
    steps: [
      { text: 'Open this notebook’s journal; it comes up over whatever you are reading.', commandId: C.openJournal },
      { text: 'Today is already open with an empty block in it — start typing. Nothing is logged until you write something.' },
      { text: 'Click any day in the calendar to read or write that one.' },
      { text: 'Staying a while? Expand it into a page of the workspace.', commandId: C.expandJournal },
      { text: 'Set the date the journal begins; the calendar starts there.' },
    ],
    commands: [C.openJournal, C.expandJournal],
    controls: [P.journalCalendar],
    menus: [],
  },
  {
    id: 'aside',
    title: 'Ideas live and die differently',
    lede:
      'Most questions do not get answered; they get set aside. Discarding one asks what happened and moves it to a shelf below the working ones, with everything intact — it comes back whenever you want it. Deleting is a different act, offered only on that shelf, and it puts the notebook in the bin rather than taking it away: the journal, the claims and the references go with it and all of them come back if you put it back. Nothing here goes for good until you empty the bin, and that is the one act in the app that asks.',
    motion: 'aside',
    motionCaption: 'A notebook sliding down to the shelf below, and being lifted back up again.',
    steps: [
      { text: 'On What next, discard the one you are done with and say why.' },
      { text: 'It is on the discarded shelf, with your reason on it. Restore puts it straight back.' },
      { text: 'Delete is only ever offered there. It moves the notebook to the bin at the bottom of the list.' },
      { text: 'Changed your mind? Put it back, and it is on the discarded shelf again with everything it had.' },
      { text: 'Empty the bin when you mean it. That is the only thing in this app that destroys a line of work — and it says what goes and what stays.' },
    ],
    commands: [],
    controls: [P.notebookDiscard, P.notebookDelete, P.notebookEmptyBin],
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
      { text: 'Open the librarian; it comes up over the workspace, from the wiki or from anywhere.', commandId: C.openLibrarian },
      { text: 'Read the disclosure — what leaves this machine, and what never does — then switch it on.' },
      { text: 'Ask it to look. It works in the background and reports as it goes.' },
      { text: 'Go through the proposals one at a time. Accept makes the link; refuse makes nothing.' },
    ],
    commands: [C.openLibrarian],
    controls: [P.librarianConsent, P.librarianRun, P.librarianProposals],
    menus: [],
  },
  {
    id: 'demo',
    title: 'Something to look at while this is being built',
    lede:
      'Every page in this application is a view of something you made, so a library with nothing in it is fourteen empty panels — which is a bad thing to design against and a worse thing to learn the app from. One action fills all of it with invented papers, marked sentences, links, a notebook with claims and a journal, and one action takes every bit of it away again. None of it is anybody’s data, none of it is committed, and none of it exists in a packaged build: ask for it there and it says so.',
    motion: 'demo',
    motionCaption: 'A library filling up with papers, and then emptying again.',
    steps: [
      { text: 'Fill the library. The papers, the highlights, the links, the notebooks and the journal all arrive together.', commandId: C.fillDemoLibrary },
      { text: 'Open anything — the wiki, a ledger, a notebook page — and there is something on it.' },
      { text: 'Take it all away when you are done. Only what the demo made goes; your own library is untouched.', commandId: C.clearDemoLibrary },
    ],
    commands: [C.fillDemoLibrary, C.clearDemoLibrary],
    controls: [],
    menus: [],
  },
  {
    id: 'lost',
    title: 'When you cannot remember how',
    lede:
      'Three doors, and none of them needs you to already know a key. The command list is everything the app can do, searchable by what you would call it. Help is the same registry printed with its chords, so it can never disagree with what the keys actually do — and every command on it carries a small moving picture of its own act, because a name is not a demonstration. This guide is where to come back to when the question is “what does this do” rather than “which key”.',
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
