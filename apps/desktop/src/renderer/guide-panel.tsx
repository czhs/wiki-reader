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
 * Inline SVGs, animated by keyframes in `guide.css`, which ships with the app. Nothing is
 * fetched, there is no animation library, and `prefers-reduced-motion` turns all of it off and
 * leaves a still diagram — every drawing's static attributes are its resting state. The
 * drawings themselves live in `motions.tsx`, because the help page draws one beside every
 * command (`D03`) out of the same set.
 */
import { Fragment, useMemo } from 'react';
import {
  COMMAND_IDS,
  GUIDE_CHAPTERS,
  contextMenuKinds,
  guideCoverage,
  panelControl,
  type GuideChapter,
} from '@wr/workbench';
import { MOTIONS } from './motions.js';
import { Chord } from './overlays.js';
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
          {/*
            Three runs, not one wrapped row. Coverage is deliberately three-tiered — a command
            you can press anywhere, a control that exists on one panel, a menu you reach by
            right-clicking the thing — and drawing them as one kind of chip said a widget on two
            panels and a global key were the same sort of thing. The tiers are the guide's best
            idea; the page has to teach them rather than flatten them.
          */}
          {chapter.commands.length > 0 && (
            <div className="wr-guide__covers-run">
              <span className="wr-guide__covers-label">Press</span>
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
                    <Chord chord={chords[0]} platform={platform} />
                  </span>
                );
              })}
            </div>
          )}
          {chapter.controls.length > 0 && (
            <div className="wr-guide__covers-run">
              <span className="wr-guide__covers-label">On the panel</span>
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
            </div>
          )}
          {chapter.menus.length > 0 && (
            <div className="wr-guide__covers-run">
              <span className="wr-guide__covers-label">Right-click</span>
              {chapter.menus.map((kind) => (
                <span
                  className="wr-guide__covers-item wr-guide__covers-item--menu"
                  key={kind}
                  data-guide-menu={kind}
                  data-testid={`guide-menu-${kind}`}
                >
                  {kind.replace(/-/g, ' ')}
                </span>
              ))}
            </div>
          )}
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

/**
 * The guide (`O01`), which takes no arguments and has no descriptor to read.
 *
 * A stateless page, so there is nothing between Dockview's props and the page — the wrapper
 * that used to sit here forwarded a `panelId` nothing on the page could use.
 */
export function GuidePanel(): JSX.Element {
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
