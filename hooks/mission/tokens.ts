/**
 * Mission Control's colours and type, from the design: one token set per theme, chosen by one `theme` value.
 * Surfaces are translucent so they sit on whatever background Claude's app has. No `$` here: these files are pure.
 */

export type ThemeName = 'dark' | 'light'
/** `auto` follows the app: every drawing carries both sets and CSS picks one. */
export type ThemeMode = ThemeName | 'auto'

export type Tokens = {
  name: ThemeName
  surface: string
  text: string
  secondary: string
  tertiary: string
  line: string
  grid: string
  /** The skeleton's placeholder bars. */
  skeleton: string
  working: string
  done: string
  queued: string
  needs: string
  /** In review: reported, waiting on the orchestrator. Pink, apart from needs-you's amber and failed's red. */
  review: string
  orch: string
  failed: string
  /**
   * The status colours as text: the same in dark; in light a darker tone, since the graphic
   * tones don't reach 4.5:1 there (each one checked on the background, a card, the LIVE pill and
   * its own 12% wash).
   */
  ink: { working: string; done: string; needs: string; failed: string; orch: string; review: string }
  /** The faint queued link's strength (dark 35%; light 55%, where 35% vanished). */
  queuedLink: number
  /**
   * Idle (no role in the task): the faintest status tone, for its ring, glyph, dot and link. In
   * light it still reaches 3:1 as a graphic (3.39 on the background, 3.18 on a card); its text is
   * tertiary.
   */
  idle: string
  /** The idle link's strength: fainter than queued's. */
  idleLink: number
  /**
   * A queued card's opacity: dimmed in dark; whole in light, where dimming it took it below the
   * idle card (whose text must keep 4.5:1), and idle is to be the quietest state.
   */
  queuedOpacity: number
  /** Status fills at reduced strength: done segments, discs. */
  doneSoft: string
  failedSoft: string
  workingFill: string
  doneFill: string
  needsFill: string
  reviewFill: string
  orchFill: string
  /**
   * Who an event is from, in the Activity view (its dot and name): the person, the orchestrator (its
   * circle's purple), each helper role, and any other agent (neutral). Each at least 4.5:1 on the
   * pane's background, none the exact Needs you, In review or Done token.
   */
  actor: Record<Actor, string>
  track: string
  skipLine: string
  /** Glow strengths (alpha), softer in light. */
  glowNow: number
  glowDot: number
  glowNode: number
  glowOrch: number
  glowCard: number
  /** The live pill's fill and border. */
  liveFill: string
  liveLine: string
  /** The PAUSED chip, built as LIVE's from green, from Needs you's amber (its ink: ink.needs, 6.90 / 5.16 on it). */
  pausedFill: string
  pausedLine: string
  /** The strongest text: the ORCH label on the needs-you disc (11.73 / 14.74 on its tint). */
  strong: string
  quietFill: string
  quietLine: string
}

/** RGB of a hex colour, for the alphas below. */
/** The senders the Activity view tells apart by colour. */
export type Actor = 'user' | 'orchestrator' | 'explorer' | 'worker' | 'tester' | 'security' | 'other'

const rgb = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16)
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
}
const a = (hex: string, alpha: number): string => `rgba(${rgb(hex)},${alpha})`

const darkStatus = { working: '#56CCFF', done: '#3DDC97', queued: '#5B677E', needs: '#F6B74A', review: '#FF7AC6', orch: '#9D8CFF', failed: '#FF6B7A' }
const lightStatus = { working: '#0A84C6', done: '#12996B', queued: '#7A8597', needs: '#B87400', review: '#D6409A', orch: '#6A55E0', failed: '#D4374A' }

export const DARK: Tokens = {
  name: 'dark',
  surface: 'rgba(255,255,255,0.04)',
  text: '#E9EEF8',
  secondary: '#93A0B8',
  tertiary: '#5B677E',
  line: 'rgba(255,255,255,0.08)',
  grid: 'rgba(255,255,255,0.04)',
  skeleton: 'rgba(255,255,255,0.06)',
  ...darkStatus,
  ink: { working: darkStatus.working, done: darkStatus.done, needs: darkStatus.needs, failed: darkStatus.failed, orch: darkStatus.orch, review: darkStatus.review },
  queuedLink: 0.35,
  idle: '#4A5468',
  idleLink: 0.22,
  queuedOpacity: 0.85,
  doneSoft: a(darkStatus.done, 0.85),
  failedSoft: a(darkStatus.failed, 0.85),
  workingFill: a(darkStatus.working, 0.12),
  doneFill: a(darkStatus.done, 0.12),
  needsFill: a(darkStatus.needs, 0.12),
  reviewFill: a(darkStatus.review, 0.12),
  orchFill: a(darkStatus.orch, 0.12),
  // On the app's dark background (#262624): 15.16, 5.51, 8.14, 6.29, 10.05, 6.80, 5.75.
  actor: { user: '#FFFFFF', orchestrator: darkStatus.orch, explorer: '#2DD4BF', worker: '#6EA8FF', tester: '#A3E635', security: '#FF8F70', other: '#93A0B8' },
  track: 'rgba(255,255,255,0.10)',
  skipLine: 'rgba(255,255,255,0.30)',
  glowNow: 0.6,
  glowDot: 0.7,
  glowNode: 0.45,
  glowOrch: 0.35,
  glowCard: 0.16,
  liveFill: a(darkStatus.done, 0.1),
  liveLine: a(darkStatus.done, 0.25),
  pausedFill: a(darkStatus.needs, 0.1),
  pausedLine: a(darkStatus.needs, 0.25),
  strong: '#FFFFFF',
  quietFill: 'rgba(91,103,126,0.12)',
  quietLine: 'rgba(91,103,126,0.35)',
}

export const LIGHT: Tokens = {
  name: 'light',
  surface: 'rgba(0,0,0,0.03)',
  text: '#141821',
  secondary: '#4B5568',
  // Tertiary is mostly text: #7A8597 was 3.1:1; #5A6475 is 5.3:1 on a card.
  tertiary: '#5A6475',
  // Black 8% (1.2:1) and 4% (1.09:1) all but vanished on the light background.
  line: 'rgba(0,0,0,0.14)',
  grid: 'rgba(0,0,0,0.07)',
  skeleton: 'rgba(0,0,0,0.06)',
  ...lightStatus,
  // Text tones (contrast on #FAF9F5 / a card / the LIVE pill / the status's own 12% wash):
  // working 5.65 / 5.30 / 5.04 / 4.60, done 5.64 / 5.29 / 5.03 / 4.63, needs 5.76 / 5.41 / 5.13 /
  // 4.75, failed 6.03 / 5.66 / 5.38 / 4.81, orchestrator 5.74 / 5.39 / 5.12 / 4.61, in review
  // 6.07 / 5.70 / - / 4.91, shifted toward magenta to stay apart from failed's crimson (its graphic
  // tone #D6409A: 3.94 / 3.70 / - / 3.19).
  ink: { working: '#0B699E', done: '#0B724F', needs: '#8B5700', failed: '#B42839', orch: '#614ECC', review: '#A8248A' },
  queuedLink: 0.55,
  idle: '#7F8898',
  idleLink: 0.32,
  queuedOpacity: 1,
  doneSoft: a(lightStatus.done, 0.85),
  failedSoft: a(lightStatus.failed, 0.85),
  workingFill: a(lightStatus.working, 0.12),
  doneFill: a(lightStatus.done, 0.12),
  needsFill: a(lightStatus.needs, 0.12),
  reviewFill: a(lightStatus.review, 0.12),
  orchFill: a(lightStatus.orch, 0.12),
  // On #FAF9F5: 16.86, 5.00, 5.20, 5.52, 4.74, 4.92, 7.12.
  actor: { user: '#141821', orchestrator: lightStatus.orch, explorer: '#0F766E', worker: '#1D5FD1', tester: '#4D7C0F', security: '#C2410C', other: '#4B5568' },
  track: 'rgba(0,0,0,0.10)',
  skipLine: 'rgba(0,0,0,0.30)',
  glowNow: 0.3,
  glowDot: 0.35,
  glowNode: 0.22,
  glowOrch: 0.18,
  glowCard: 0.08,
  liveFill: a(lightStatus.done, 0.1),
  liveLine: a(lightStatus.done, 0.3),
  pausedFill: a(lightStatus.needs, 0.1),
  pausedLine: a(lightStatus.needs, 0.3),
  strong: '#141821',
  quietFill: 'rgba(122,133,151,0.12)',
  quietLine: 'rgba(122,133,151,0.35)',
}

export const TOKENS: Record<ThemeName, Tokens> = { dark: DARK, light: LIGHT }

/** A colour at an alpha, for glows (`rgba(r,g,b,a)` from a hex). */
export const alpha = a

/**
 * Colours for the native pieces in `auto` (a Box can't follow a media query): neutral greys that
 * land close to both sets' translucent values on either background.
 */
export const NEUTRAL = { surface: 'rgba(128,128,128,0.06)', line: 'rgba(128,128,128,0.22)', hover: 'rgba(128,128,128,0.12)' }

/**
 * The app's own faces (they match the app's native text), with the Windows and Linux faces after
 * them. Names with spaces are in single quotes: the stacks go into double-quoted SVG attributes.
 */
export const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
export const MONO = "ui-monospace, SFMono-Regular, Menlo, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace"

/** The drawing column's width: the layout is the design's 400. */
export const W = 400

