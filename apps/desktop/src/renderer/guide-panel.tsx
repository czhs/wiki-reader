/**
 * The guide page (criterion `O01`): what this app does, and how to use it.
 *
 * The division of labour with the help page (`D02`) is the whole point of this file existing.
 * Help is the registries printed — every command, every chord, grouped by category and by
 * keyboard family — and it answers "which key does this". It is a reference, and a reference is
 * useless to someone who does not yet know what to look up. This page answers the other
 * question: what is this app for, what can be done in it, and how. It is written as chapters in
 * the order a researcher meets the app, each one with a picture of the thing working.
 *
 * ## Where the words come from
 *
 * The chapters (`@wr/workbench`'s `guide.ts`) hold only prose and *ids*. Every command's title
 * and every chord printed beside a step is read out of the live registries here, exactly as the
 * help page and the context menus do — three surfaces, one authority. A guide that spelled out
 * its own titles would be a manual that drifts.
 *
 * ## Why the coverage is on the page and not only in the test
 *
 * `guideCoverage` runs against `commands.all()` on mount. If a command exists that no chapter
 * covers, the page says so, by name, in a warning band at the top — as well as failing
 * `guide.test.ts` and the `[O01]` end-to-end test. Putting the gap on the page is what makes
 * the rule ("a feature is not done until the guide shows it") enforce itself in front of
 * whoever is looking at the app, rather than only in CI where nobody reads it until it is red.
 *
 * ## The motion
 *
 * Fourteen inline SVGs, animated by keyframes in `guide.css`, which ships with the app. Nothing
 * is fetched, there is no animation library, and `prefers-reduced-motion` turns all of it off
 * and leaves a still diagram — every drawing's static attributes are its resting state.
 */
import { Fragment, useMemo } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import {
  COMMAND_IDS,
  GUIDE_CHAPTERS,
  contextMenuKinds,
  guideCoverage,
  panelControl,
  type GuideChapter,
  type GuideMotion,
  type Platform,
} from '@wr/workbench';
import { displayChord } from './overlays.js';
import { useWorkspace } from './workspace.js';

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

/**
 * A chapter's text, with backticked spans set as code.
 *
 * Deliberately the whole of the markup this page supports. A guide written in full markdown
 * would need a renderer, a sanitiser and a decision about links; a guide that could not write
 * `$$…$$` without it being read as a formula could not describe the notebook. One rule is
 * enough, and it is the one the prose actually needs.
 */
function Prose({ text }: { readonly text: string }): JSX.Element {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <code key={`${String(index)}:${part}`}>{part}</code>
        ) : (
          <Fragment key={`${String(index)}:${part}`}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Chord({
  chord,
  platform,
}: {
  readonly chord: string;
  readonly platform: Platform;
}): JSX.Element {
  return <kbd className="wr-kbd wr-kbd--inline">{displayChord(chord, platform)}</kbd>;
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

const BOX = { viewBox: '0 0 240 130', role: 'img' } as const;

/**
 * One drawing per `GuideMotion`.
 *
 * Each is a diagram of the thing the chapter is about, moving the way the thing moves: a mark
 * settles over a sentence, an edge draws itself, a filter dims a graph and pans to the match, a
 * card lifts off a page and lands on a desk. The classes are the contract with `guide.css` —
 * `g-*` names an animated part, and the element's own attributes are where it rests.
 */
const MOTIONS: Readonly<Record<GuideMotion, () => JSX.Element>> = {
  shelf: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="Items arriving into the library list">
      <rect className="g-paper" x="10" y="10" width="220" height="110" rx="4" />
      {[26, 58, 90].map((y, index) => (
        <g key={y} className={index === 0 ? 'g-shelf-row' : `g-shelf-row g-delay-${String(index)}`}>
          <rect className="g-line" x="22" y={y} width="140" height="7" rx="3" />
          <rect className="g-line" x="22" y={y + 12} width="86" height="5" rx="2.5" opacity="0.6" />
          <circle className="g-accent" cx="212" cy={y + 6} r="4" />
        </g>
      ))}
    </svg>
  ),

  read: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A second document opening beside the first">
      <g>
        <rect className="g-paper" x="12" y="12" width="102" height="106" rx="4" />
        {[26, 40, 54, 68, 82, 96].map((y) => (
          <rect key={y} className="g-line" x="24" y={y} width={y % 28 === 12 ? 60 : 78} height="5" rx="2.5" />
        ))}
      </g>
      <g className="g-second-panel">
        <rect className="g-paper" x="126" y="12" width="102" height="106" rx="4" />
        {[26, 40, 54, 68, 82].map((y) => (
          <rect key={y} className="g-line" x="138" y={y} width="78" height="5" rx="2.5" />
        ))}
        <rect className="g-accent" x="138" y="96" width="46" height="7" rx="3.5" />
      </g>
    </svg>
  ),

  mark: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A highlight settling over a sentence">
      <rect className="g-paper" x="14" y="12" width="212" height="106" rx="4" />
      {[28, 48, 68, 88].map((y) => (
        <rect key={y} className="g-line" x="28" y={y} width={y === 88 ? 120 : 184} height="6" rx="3" />
      ))}
      <rect className="g-mark g-sweep" x="26" y="44" width="150" height="14" rx="3" />
      <rect className="g-accent" x="26" y="44" width="3" height="14" rx="1.5" />
    </svg>
  ),

  search: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="Passages found, and one of them opening">
      <rect className="g-paper" x="14" y="12" width="212" height="26" rx="13" />
      <g className="g-glass">
        <circle cx="34" cy="25" r="7" fill="none" stroke="var(--wr-accent)" strokeWidth="2" />
        <line x1="39" y1="30" x2="45" y2="36" stroke="var(--wr-accent)" strokeWidth="2" strokeLinecap="round" />
      </g>
      {[50, 76, 102].map((y, index) => (
        <g key={y} className={index === 0 ? 'g-result' : `g-result g-delay-${String(index)}`}>
          <rect className="g-paper" x="14" y={y} width="212" height="20" rx="3" />
          <rect className="g-line" x="24" y={y + 7} width="120" height="6" rx="3" />
          <rect className="g-mark" x="150" y={y + 6} width="42" height="8" rx="3" />
        </g>
      ))}
    </svg>
  ),

  link: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A typed link being drawn between two things">
      <path className="g-edge g-draw" d="M76 76 H164" />
      <circle className="g-node" cx="60" cy="76" r="16" />
      <circle className="g-node" cx="180" cy="76" r="16" />
      <text className="g-label g-late" x="120" y="62" textAnchor="middle">
        supports
      </text>
      <text className="g-label" x="60" y="112" textAnchor="middle">
        this sentence
      </text>
      <text className="g-label" x="180" y="112" textAnchor="middle">
        that claim
      </text>
    </svg>
  ),

  retrace: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A step forward along a trail, then back along it">
      <path className="g-edge" d="M30 70 H150" strokeDasharray="3 5" />
      {[30, 90, 150].map((x) => (
        <rect key={x} className="g-paper" x={x - 16} y="40" width="32" height="42" rx="3" />
      ))}
      <g className="g-walker">
        <circle className="g-accent" cx="30" cy="98" r="6" />
      </g>
      <text className="g-label" x="120" y="122" textAnchor="middle">
        back · forward
      </text>
    </svg>
  ),

  map: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A filter dimming a graph and panning to the match">
      <g className="g-panning">
        <g className="g-dimmed">
          <path className="g-edge" d="M52 40 L96 76 M96 76 L60 104 M96 76 L154 74 M154 74 L196 104 M154 74 L188 36" />
          <circle className="g-node" cx="52" cy="40" r="9" />
          <circle className="g-node" cx="96" cy="76" r="11" />
          <circle className="g-node" cx="60" cy="104" r="8" />
          <circle className="g-node" cx="196" cy="104" r="8" />
          <circle className="g-node" cx="188" cy="36" r="9" />
        </g>
        <circle className="g-node" cx="154" cy="74" r="12" />
        <circle className="g-ring" cx="154" cy="74" r="19" />
      </g>
    </svg>
  ),

  note: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A note made from the page it belongs to">
      <rect className="g-paper" x="14" y="16" width="94" height="98" rx="4" />
      {[30, 44, 58, 72, 86].map((y) => (
        <rect key={y} className="g-line" x="26" y={y} width="70" height="5" rx="2.5" />
      ))}
      <rect className="g-mark" x="26" y="56" width="70" height="9" rx="3" />
      <g className="g-spawn">
        <path className="g-edge g-edge--accent" d="M110 62 H130" />
        <rect className="g-paper" x="132" y="30" width="94" height="70" rx="4" />
        <rect className="g-accent" x="144" y="44" width="40" height="6" rx="3" />
        {[60, 72, 84].map((y) => (
          <rect key={y} className="g-line" x="144" y={y} width="70" height="5" rx="2.5" />
        ))}
      </g>
    </svg>
  ),

  blocks: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A page being built a block at a time, ending in typeset maths">
      <rect className="g-paper" x="14" y="10" width="212" height="110" rx="4" />
      <g className="g-block">
        <rect className="g-line" x="28" y="24" width="150" height="6" rx="3" />
        <rect className="g-line" x="28" y="36" width="184" height="6" rx="3" opacity="0.6" />
      </g>
      <g className="g-block g-delay-1">
        <rect x="28" y="52" width="184" height="26" rx="3" fill="var(--wr-bg-sunken)" stroke="var(--wr-border-strong)" />
        <rect className="g-accent" x="36" y="61" width="54" height="4" rx="2" />
        <rect className="g-line" x="36" y="69" width="94" height="4" rx="2" />
      </g>
      <g className="g-block g-delay-2">
        <g className="g-formula">
          <text className="g-label" x="120" y="102" textAnchor="middle" fontSize="17">
            E = mc²
          </text>
        </g>
      </g>
    </svg>
  ),

  desk: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A marked sentence landing as a card on a notebook's desk">
      <rect className="g-paper" x="12" y="10" width="86" height="80" rx="4" />
      {[24, 38, 52, 66].map((y) => (
        <rect key={y} className="g-line" x="22" y={y} width="66" height="5" rx="2.5" />
      ))}
      <rect className="g-paper" x="120" y="58" width="108" height="60" rx="4" />
      <text className="g-label" x="174" y="74" textAnchor="middle">
        the desk
      </text>
      <g className="g-flyer">
        <rect className="g-mark" x="22" y="36" width="66" height="10" rx="3" />
        <rect x="22" y="36" width="66" height="10" rx="3" fill="none" stroke="var(--wr-accent)" />
      </g>
    </svg>
  ),

  calendar: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A month drawn day by day, the written ones filling in">
      <rect className="g-paper" x="10" y="10" width="220" height="110" rx="4" />
      {Array.from({ length: 28 }, (_, index) => {
        const column = index % 7;
        const row = Math.floor(index / 7);
        const written = [2, 3, 9, 16].indexOf(index);
        const x = 22 + column * 29;
        const y = 26 + row * 22;
        return (
          <Fragment key={index}>
            <rect
              x={x}
              y={y}
              width="22"
              height="16"
              rx="2"
              fill="none"
              stroke="var(--wr-border-strong)"
            />
            {written >= 0 && (
              <rect
                className={written === 0 ? 'g-accent g-written' : `g-accent g-written g-delay-${String(Math.min(written, 3))}`}
                x={x + 3}
                y={y + 3}
                width="16"
                height="10"
                rx="2"
              />
            )}
          </Fragment>
        );
      })}
    </svg>
  ),

  aside: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A notebook set aside onto the shelf below, and lifted back">
      <text className="g-label" x="16" y="18">
        working
      </text>
      <rect className="g-paper" x="16" y="24" width="98" height="26" rx="3" />
      <rect className="g-paper" x="126" y="24" width="98" height="26" rx="3" />
      <line x1="12" y1="66" x2="228" y2="66" stroke="var(--wr-border-strong)" strokeDasharray="4 4" />
      <text className="g-label" x="16" y="80">
        discarded
      </text>
      <g className="g-set-aside">
        <rect className="g-paper" x="16" y="42" width="98" height="26" rx="3" />
        <rect className="g-accent" x="26" y="52" width="52" height="6" rx="3" />
      </g>
    </svg>
  ),

  propose: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A proposal becoming a link once it is accepted">
      <path className="g-edge g-proposal" d="M74 70 H166" />
      <path className="g-edge g-edge--accent g-accepted" d="M74 70 H166" />
      <circle className="g-node" cx="58" cy="70" r="15" />
      <circle className="g-node" cx="182" cy="70" r="15" />
      <text className="g-label" x="120" y="56" textAnchor="middle">
        proposed
      </text>
      <text className="g-label g-accepted" x="120" y="104" textAnchor="middle">
        accepted by you
      </text>
    </svg>
  ),

  keys: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A chord pressed, and the page it opens arriving">
      <g className="g-keycap">
        <rect x="18" y="46" width="66" height="38" rx="6" fill="var(--wr-bg-raised)" stroke="var(--wr-border-strong)" />
        <text className="g-label" x="51" y="70" textAnchor="middle" fontSize="13">
          ⌘⇧
        </text>
      </g>
      <g className="g-opened">
        <rect className="g-paper" x="106" y="18" width="118" height="94" rx="4" />
        <rect className="g-accent" x="118" y="32" width="56" height="7" rx="3.5" />
        {[50, 64, 78, 92].map((y) => (
          <rect key={y} className="g-line" x="118" y={y} width="94" height="5" rx="2.5" />
        ))}
      </g>
    </svg>
  ),
};

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function ChapterSection({ chapter }: { readonly chapter: GuideChapter }): JSX.Element {
  const { workbench } = useWorkspace();
  const platform = workbench.keybindings.platform;
  const Motion = MOTIONS[chapter.motion];

  return (
    <section
      className="wr-guide__chapter"
      id={`guide-${chapter.id}`}
      data-testid={`guide-chapter-${chapter.id}`}
      data-motion={chapter.motion}
    >
      <div className="wr-guide__body">
        <h3 className="wr-guide__chapter-title">{chapter.title}</h3>
        <p className="wr-guide__lede">
          <Prose text={chapter.lede} />
        </p>
        <ol className="wr-guide__steps">
          {chapter.steps.map((step, index) => {
            const chord =
              step.commandId === undefined
                ? undefined
                : workbench.keybindings.chordsForCommand(step.commandId)[0];
            return (
              <li
                className="wr-guide__step"
                key={`${chapter.id}:${String(index)}`}
                data-testid={`guide-step-${chapter.id}-${String(index)}`}
                {...(step.commandId === undefined ? {} : { 'data-command-id': step.commandId })}
              >
                <Prose text={step.text} />
                {chord !== undefined && (
                  <span className="wr-guide__step-chord">
                    <Chord chord={chord} platform={platform} />
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        {/*
          What this chapter accounts for. The list is the reason the guide can be checked
          against the registry at all — and every word in it is the registry's own, so a
          renamed command is renamed here without this file being touched.
        */}
        <div className="wr-guide__covers">
          <span className="wr-guide__covers-label">Covers</span>
          {chapter.commands.map((commandId) => {
            const command = workbench.commands.get(commandId);
            const chords = workbench.keybindings.chordsForCommand(commandId);
            return (
              <span
                className="wr-guide__covers-item"
                key={commandId}
                data-guide-covers={commandId}
                data-testid={`guide-covers-${commandId}`}
              >
                {command?.title ?? commandId}
                {chords[0] !== undefined && <Chord chord={chords[0]} platform={platform} />}
              </span>
            );
          })}
          {chapter.controls.map((controlId) => {
            const control = panelControl(controlId);
            return (
              <span
                className="wr-guide__covers-item wr-guide__covers-item--control"
                key={controlId}
                data-guide-control={controlId}
                data-testid={`guide-control-${controlId}`}
                title={control.hint}
              >
                {control.title}
                <span className="wr-guide__covers-where">{control.surface}</span>
              </span>
            );
          })}
          {chapter.menus.map((kind) => (
            <span
              className="wr-guide__covers-item wr-guide__covers-item--control"
              key={kind}
              data-guide-menu={kind}
              data-testid={`guide-menu-${kind}`}
            >
              right-click: {kind.replace(/-/g, ' ')}
            </span>
          ))}
        </div>
      </div>

      <figure className="wr-guide__figure">
        <Motion />
        <figcaption className="wr-guide__caption" data-testid={`guide-caption-${chapter.id}`}>
          {chapter.motionCaption}
        </figcaption>
      </figure>
    </section>
  );
}

export function GuidePanelBody(): JSX.Element {
  const { workbench } = useWorkspace();

  // Read once per mount, for the reason the help page gives: neither registry has a change
  // event, and both are settled before the first panel exists.
  const commands = useMemo(() => [...workbench.commands.all()], [workbench]);
  const coverage = useMemo(
    () => guideCoverage(commands, GUIDE_CHAPTERS, contextMenuKinds()),
    [commands],
  );
  const helpChord = workbench.keybindings.chordsForCommand(COMMAND_IDS.openHelp)[0];

  return (
    <div
      className="wr-guide"
      data-testid="guide-panel"
      data-chapter-count={String(GUIDE_CHAPTERS.length)}
      data-command-count={String(commands.length)}
      data-covered-count={String(coverage.covered.length)}
      data-uncovered-count={String(coverage.missing.length)}
      data-unknown-count={String(coverage.unknown.length)}
      data-uncovered-controls={String(coverage.missingControls.length)}
      data-complete={coverage.complete ? 'true' : 'false'}
    >
      <header className="wr-guide__head">
        <h2 className="wr-guide__title">How to use this</h2>
        <p className="wr-guide__blurb" data-testid="guide-summary">
          {commands.length} things this app can do, and every one of them is in a chapter below,
          with the panel controls that are not commands and the menus you get by right-clicking.
          The chapters are checked against the command registry each time this page opens, so it
          cannot quietly fall behind the app. For which key does what, the help page is next door
          {helpChord === undefined ? '.' : ':'}
          {helpChord !== undefined && (
            <>
              {' '}
              <Chord chord={helpChord} platform={workbench.keybindings.platform} />
            </>
          )}
        </p>
        <nav className="wr-guide__contents" data-testid="guide-contents" aria-label="Chapters">
          {GUIDE_CHAPTERS.map((chapter) => (
            <a
              className="wr-guide__contents-link"
              key={chapter.id}
              href={`#guide-${chapter.id}`}
              data-testid={`guide-contents-${chapter.id}`}
            >
              {chapter.title}
            </a>
          ))}
        </nav>
      </header>

      {/*
        The rule enforcing itself. Drawn only when something is uncovered, and by name — this is
        how "a feature is not done until the guide shows it" reaches the person adding the
        feature rather than only the test that runs afterwards.
      */}
      {!coverage.complete && (
        <section className="wr-guide__gaps" data-testid="guide-gaps">
          <h3>Not yet in the guide</h3>
          <ul>
            {coverage.missing.map((command) => (
              <li key={command.id} data-testid={`guide-gap-${command.id}`}>
                {command.label}
              </li>
            ))}
            {coverage.unknown.map((commandId) => (
              <li key={commandId} data-testid={`guide-unknown-${commandId}`}>
                {commandId} — named by a chapter, registered by nothing
              </li>
            ))}
            {coverage.missingControls.map((controlId) => (
              <li key={controlId} data-testid={`guide-gap-control-${controlId}`}>
                {panelControl(controlId).title}
              </li>
            ))}
            {coverage.missingMenus.map((kind) => (
              <li key={kind} data-testid={`guide-gap-menu-${kind}`}>
                right-click on a {kind.replace(/-/g, ' ')}
              </li>
            ))}
          </ul>
        </section>
      )}

      {GUIDE_CHAPTERS.map((chapter) => (
        <ChapterSection chapter={chapter} key={chapter.id} />
      ))}
    </div>
  );
}

export function GuidePanel(_props: IDockviewPanelProps<{ panelId: string }>): JSX.Element {
  return <GuidePanelBody />;
}
