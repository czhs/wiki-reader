/**
 * The drawings — one inline animated SVG per motion, shared by the guide and the help page.
 *
 * The guide (`O01`) drew fourteen of these, one per chapter, and owned them privately. `D03`
 * puts a picture beside every command on the help page, which is the same machinery pointed at
 * a different list: the same ink, the same keyframes in `guide.css`, the same rule that
 * `prefers-reduced-motion` switches all of it off. So the drawings move here, where two pages
 * can draw them, rather than being copied — a second copy is how the two would drift into
 * looking like different applications.
 *
 * Two rules every drawing is built under, unchanged from the guide:
 *
 * - **It is legible at rest.** Every element's static attributes are its resting state, and the
 *   keyframes move away from that and back — which is what lets reduced motion be a single
 *   `animation: none` rather than a second set of artwork.
 * - **Nothing is fetched.** No sprite sheet, no icon font, no CDN, no animation library. A
 *   local-first reader that reached the network to explain itself would be contradicting the
 *   sentence it was drawing.
 *
 * The classes are the contract with `guide.css`: `g-*` names an animated part, and the
 * element's own attributes are where it rests.
 */
import { Fragment } from 'react';
import type { CommandMotion } from '@wr/workbench';

const BOX = { viewBox: '0 0 240 130', role: 'img' } as const;

export const MOTIONS: Readonly<Record<CommandMotion, () => JSX.Element>> = {
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

  send: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A marked sentence landing as a block in a notebook's page">
      <rect className="g-paper" x="12" y="10" width="86" height="80" rx="4" />
      {[24, 38, 52, 66].map((y) => (
        <rect key={y} className="g-line" x="22" y={y} width="66" height="5" rx="2.5" />
      ))}
      <rect className="g-paper" x="120" y="58" width="108" height="60" rx="4" />
      <text className="g-label" x="174" y="74" textAnchor="middle">
        the page
      </text>
      {/* The blocks already written on it; the flyer lands as one more. */}
      {[86, 98].map((y) => (
        <rect key={y} className="g-line" x="130" y={y} width="88" height="5" rx="2.5" />
      ))}
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

  // --- the four the chapters never needed ---------------------------------
  // A chapter is about a subject; a command is about an act, and these four acts are the ones
  // whose subject's drawing says the opposite of what they do.

  close: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A tab closing, and the panel beside it taking the room">
      <rect className="g-paper" x="12" y="12" width="216" height="106" rx="4" />
      <rect className="g-paper" x="12" y="12" width="70" height="20" rx="3" />
      <rect className="g-line" x="22" y="19" width="34" height="6" rx="3" />
      <g className="g-closing">
        <rect className="g-paper" x="84" y="12" width="70" height="20" rx="3" />
        <rect className="g-line" x="94" y="19" width="34" height="6" rx="3" />
        <path
          className="g-cross"
          d="M138 17 l8 8 M146 17 l-8 8"
          stroke="var(--wr-danger)"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </g>
      {[48, 62, 76, 90].map((y) => (
        <rect key={y} className="g-line" x="24" y={y} width="188" height="5" rx="2.5" />
      ))}
    </svg>
  ),

  unlink: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A link between two things being taken away">
      <path className="g-edge g-severed" d="M76 70 H164" />
      <circle className="g-node" cx="60" cy="70" r="16" />
      <circle className="g-node" cx="180" cy="70" r="16" />
      <g className="g-cut">
        <path
          d="M112 44 l16 52 M128 44 l-16 52"
          stroke="var(--wr-danger)"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      </g>
      <text className="g-label" x="120" y="118" textAnchor="middle">
        both ends stay
      </text>
    </svg>
  ),

  gather: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="Everything that refers to one thing gathering into a list">
      <circle className="g-node" cx="42" cy="66" r="17" />
      <text className="g-label" x="42" y="104" textAnchor="middle">
        this one
      </text>
      {[16, 46, 76].map((y, index) => (
        <g key={y} className={index === 0 ? 'g-gathered' : `g-gathered g-delay-${String(index)}`}>
          <path className="g-edge" d={`M60 66 H108`} />
          <rect className="g-paper" x="110" y={y} width="116" height="26" rx="3" />
          <rect className="g-line" x="120" y={y + 8} width="70" height="6" rx="3" />
          <rect className="g-mark" x="196" y={y + 7} width="20" height="8" rx="3" />
        </g>
      ))}
    </svg>
  ),

  save: () => (
    <svg {...BOX} className="wr-guide__motion" aria-label="A page of writing committed without leaving the sentence">
      <rect className="g-paper" x="14" y="10" width="212" height="110" rx="4" />
      {[26, 40, 54, 68].map((y) => (
        <rect key={y} className="g-line" x="28" y={y} width={y === 68 ? 118 : 184} height="6" rx="3" />
      ))}
      <rect className="g-accent g-caret" x="150" y="66" width="2" height="12" />
      <g className="g-saved">
        <rect x="150" y="90" width="76" height="22" rx="11" fill="var(--wr-bg-raised)" stroke="var(--wr-accent)" />
        <path
          d="M162 101 l5 5 l10 -11"
          fill="none"
          stroke="var(--wr-accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text className="g-label" x="196" y="105" textAnchor="middle">
          saved
        </text>
      </g>
    </svg>
  ),
};
