import { alpha, type Tokens } from './tokens'
import type { AgentStatus } from './model'

/**
 * Every icon here is copied from the design file's assets (the Mission Control frames; the
 * file name of each is noted). None is drawn or substituted. An avatar is the
 * asset's disc and glyph; for a state the design shows on another role, the role's own glyph is set
 * in that state's disc and colour, as the assets do for the states they show.
 */

/** icon/orbit, 18 x 18 (p1-2c9e8). */
export const orbit = (T: Tokens, x: number, y: number): string =>
  `<g transform="translate(${x} ${y})">` +
  `<path d="M15.75 9C15.75 12.7279 12.7279 15.75 9 15.75C5.27208 15.75 2.25 12.7279 2.25 9C2.25 5.27208 5.27208 2.25 9 2.25C12.7279 2.25 15.75 5.27208 15.75 9Z" stroke-width="1.25" stroke="${T.orch}" stroke-opacity="0.5" fill="none"/>` +
  `<path d="M9 11.5C10.3807 11.5 11.5 10.3807 11.5 9C11.5 7.61929 10.3807 6.5 9 6.5C7.61929 6.5 6.5 7.61929 6.5 9C6.5 10.3807 7.61929 11.5 9 11.5Z" fill="${T.orch}"/>` +
  `<path d="M9 3.75C9.82843 3.75 10.5 3.07843 10.5 2.25C10.5 1.42157 9.82843 0.75 9 0.75C8.17157 0.75 7.5 1.42157 7.5 2.25C7.5 3.07843 8.17157 3.75 9 3.75Z" fill="${T.orch}"/>` +
  `<path d="M14.85 13.9C15.6784 13.9 16.35 13.2284 16.35 12.4C16.35 11.5716 15.6784 10.9 14.85 10.9C14.0216 10.9 13.35 11.5716 13.35 12.4C13.35 13.2284 14.0216 13.9 14.85 13.9Z" fill="${T.orch}"/>` +
  `<path d="M3.15 13.9C3.97843 13.9 4.65 13.2284 4.65 12.4C4.65 11.5716 3.97843 10.9 3.15 10.9C2.32157 10.9 1.65 11.5716 1.65 12.4C1.65 13.2284 2.32157 13.9 3.15 13.9Z" fill="${T.orch}"/>` +
  `</g>`

/** icon/chevron-right, 14 x 14 (p1-d9e52). */
export const chevronRight = (T: Tokens, x: number, y: number): string =>
  `<path transform="translate(${x} ${y})" d="M5.5 3.5L9 7L5.5 10.5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="${T.secondary}" fill="none"/>`

/** Live activity, the three bars, 12 x 12 (p1-8e7d1); each bar its own path so it can move. */
export const liveBars = (T: Tokens, x: number, y: number, animate: boolean): string => {
  const bar = (d: string, index: number) =>
    `<path class="${animate ? `m eq eq${index}` : ''}" d="${d}" fill="${T.working}"/>`
  return (
    `<g transform="translate(${x} ${y})">` +
    bar('M3 6C3 5.44772 2.55228 5 2 5C1.44772 5 1 5.44772 1 6V10C1 10.5523 1.44772 11 2 11C2.55228 11 3 10.5523 3 10V6Z', 0) +
    bar('M7 2C7 1.44772 6.55228 1 6 1C5.44772 1 5 1.44772 5 2V10C5 10.5523 5.44772 11 6 11C6.55228 11 7 10.5523 7 10V2Z', 1) +
    bar('M11 4.5C11 3.94772 10.5523 3.5 10 3.5C9.44772 3.5 9 3.94772 9 4.5V10C9 10.5523 9.44772 11 10 11C10.5523 11 11 10.5523 11 10V4.5Z', 2) +
    `</g>`
  )
}

/** A dot (p1-e0992 6px, p1-ff150 / p1-b2f6a / p1-3adc7 5px, p2-26c71 7px): a filled circle. */
export const dot = (cx: number, cy: number, r: number, fill: string, className = ''): string =>
  `<circle${className ? ` class="${className}"` : ''} cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`

/** The role glyphs, in a 28 x 28 box (flask and shield moved from their 47.75 box, -9.875). */
const GLYPHS: Record<string, (color: string) => string> = {
  // avatar/explorer (p1-2b8d9)
  explorer: color =>
    `<path d="M19.75 14C19.75 17.1756 17.1756 19.75 14 19.75C10.8244 19.75 8.25 17.1756 8.25 14C8.25 10.8244 10.8244 8.25 14 8.25C17.1756 8.25 19.75 10.8244 19.75 14Z" stroke-width="1.4" stroke="${color}" fill="none"/>` +
    `<path d="M16.5 11.5L15.15 15.15L11.5 16.5L12.85 12.85L16.5 11.5Z" fill="${color}"/>`,
  // avatar/worker (p1-66efd)
  worker: color =>
    `<path d="M11.4 10.6L8.2 14L11.4 17.4M16.6 10.6L19.8 14L16.6 17.4M14.9 9.6L13.1 18.4" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" stroke="${color}" fill="none"/>`,
  // avatar/tester (p1-f50c3)
  tester: color =>
    `<path transform="translate(-9.875 -9.875)" d="M21.875 18.475H22.675M22.675 18.475H25.075M22.675 18.475V21.975L19.775 26.975C19.6696 27.1575 19.6142 27.3645 19.6142 27.5752C19.6143 27.7859 19.6698 27.9929 19.7752 28.1753C19.8806 28.3578 20.0322 28.5093 20.2147 28.6145C20.3973 28.7198 20.6043 28.7751 20.815 28.775H26.935C27.1457 28.7751 27.3527 28.7198 27.5353 28.6145C27.7178 28.5093 27.8694 28.3578 27.9748 28.1753C28.0802 27.9929 28.1357 27.7859 28.1358 27.5752C28.1358 27.3645 28.0804 27.1575 27.975 26.975L25.075 21.975V18.475M25.075 18.475H25.875M21.175 25.475H26.575" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" stroke="${color}" fill="none"/>`,
  // avatar/security (p1-63e7d)
  security: color =>
    `<g transform="translate(-9.875 -9.875)"><path d="M23.875 17.875L28.575 19.625V23.325C28.575 26.325 26.575 28.625 23.875 29.675C21.175 28.625 19.175 26.325 19.175 23.325V19.625L23.875 17.875Z" stroke-width="1.4" stroke-linejoin="round" stroke="${color}" fill="none"/>` +
    `<path d="M21.875 23.775L23.375 25.275L25.975 22.375" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" stroke="${color}" fill="none"/></g>`,
  // avatar/reviewer, the generic bot (p3-fe243)
  bot: color =>
    `<path d="M11.45 11.2H16.55C17.765 11.2 18.75 12.185 18.75 13.4V16.3C18.75 17.515 17.765 18.5 16.55 18.5H11.45C10.235 18.5 9.25 17.515 9.25 16.3V13.4C9.25 12.185 10.235 11.2 11.45 11.2Z" stroke-width="1.4" stroke="${color}" fill="none"/>` +
    `<path d="M14 11.2V8.8" stroke-width="1.4" stroke-linecap="round" stroke="${color}"/>` +
    `<path d="M12.3 15.75C12.8247 15.75 13.25 15.3247 13.25 14.8C13.25 14.2753 12.8247 13.85 12.3 13.85C11.7753 13.85 11.35 14.2753 11.35 14.8C11.35 15.3247 11.7753 15.75 12.3 15.75Z" fill="${color}"/>` +
    `<path d="M15.7 15.75C16.2247 15.75 16.65 15.3247 16.65 14.8C16.65 14.2753 16.2247 13.85 15.7 13.85C15.1753 13.85 14.75 14.2753 14.75 14.8C14.75 15.3247 15.1753 15.75 15.7 15.75Z" fill="${color}"/>`,
}

/** The role a name draws as: the four known ones, anything else the bot. */
export const roleOf = (name: string): string => {
  const key = name.trim().toLowerCase()
  return key in GLYPHS && key !== 'bot' ? key : 'bot'
}

const DISC = 'M14 27C21.1797 27 27 21.1797 27 14C27 6.8203 21.1797 1 14 1C6.8203 1 1 6.8203 1 14C1 21.1797 6.8203 27 14 27Z'
/** The queued disc's dashed ring (p3-fe243). */
const DASHED_RING =
  'M26.9383 12.7253C26.9791 13.1447 27 13.5699 27 14C27 14.4301 26.9791 14.8553 26.9383 15.2747M26.4434 10.225C26.1943 9.40286 25.866 8.61514 25.4673 7.87075M24.0495 5.75276C23.509 5.09488 22.9051 4.49101 22.2472 3.95048M20.1292 2.53271C19.3849 2.13401 18.5971 1.80566 17.775 1.55657M15.2747 1.0617C14.8553 1.02089 14.4301 1 14 1C13.5699 1 13.1447 1.02089 12.7253 1.0617M10.225 1.55657C9.40286 1.80566 8.61514 2.13401 7.87075 2.53271M5.75276 3.95048C5.09488 4.49101 4.49101 5.09488 3.95048 5.75276M2.53271 7.87075C2.13401 8.61514 1.80566 9.40286 1.55657 10.225M1.0617 12.7253C1.02089 13.1447 1 13.5699 1 14C1 14.4301 1.02089 14.8553 1.0617 15.2747M1.55657 17.775C1.80566 18.5971 2.13401 19.3849 2.53271 20.1292M3.95048 22.2472C4.49101 22.9051 5.09488 23.509 5.75276 24.0495M7.87075 25.4673C8.61514 25.866 9.40286 26.1943 10.225 26.4434M12.7253 26.9383C13.1447 26.9791 13.5699 27 14 27C14.4301 27 14.8553 26.9791 15.2747 26.9383M17.775 26.4434C18.5971 26.1943 19.3849 25.866 20.1292 25.4673M22.2472 24.0495C22.9051 23.509 23.509 22.9051 24.0495 22.2472M25.4673 20.1292C25.866 19.3849 26.1943 18.5971 26.4434 17.775'

/** A visual state of an avatar or node: an agent's status (idle also when no task runs). */
export type Look = AgentStatus

/** The disc for a state: done p1-2b8d9, working p1-f50c3, queued p3-fe243, needs me p3-4e9c0. */
const disc = (T: Tokens, look: Look, breathe: boolean): string => {
  switch (look) {
    case 'done':
      return `<path d="${DISC}" fill="${T.doneFill}" stroke-width="1.25" stroke="${T.done}" stroke-opacity="0.7"/>`
    case 'working':
      return `<path d="${DISC}" fill="${T.workingFill}" stroke-width="1.75" stroke="${T.working}"/>`
    case 'in_review':
      return `<path d="${DISC}" fill="${T.reviewFill}" stroke-width="1.5" stroke="${T.review}"/>`
    case 'needs_user':
      return `<path class="${breathe ? 'm breathe' : ''}" d="${DISC}" fill="${T.needsFill}" stroke-width="1.5" stroke="${T.needs}" stroke-opacity="0.7"/>`
    case 'idle':
      // Derived from queued (no frame of its own): a plain thin ring in the faintest tone.
      return `<path d="${DISC}" fill="${T.surface}" stroke-width="1" stroke="${T.idle}"/>`
    default:
      return `<path d="${DISC}" fill="${T.surface}"/><path d="${DASHED_RING}" stroke-width="1.25" stroke="${T.queued}" stroke-opacity="0.7" fill="none"/>`
  }
}

const glyphColor = (T: Tokens, look: Look): string =>
  ({ done: T.done, working: T.working, needs_user: T.needs, in_review: T.review, queued: T.queued, idle: T.idle })[look]

/**
 * An avatar, 28 x 28 at (x, y): disc and role glyph in the state's colours; working glows
 * (CSS drop-shadow, not feGaussianBlur).
 */
export const avatar = (T: Tokens, name: string, look: Look, x: number, y: number, motion: boolean): string => {
  const glyph = GLYPHS[roleOf(name)] ?? GLYPHS.bot
  const glow = look === 'working' ? ` style="filter:drop-shadow(0 0 5px ${alpha(T.working, T.glowNode)})"` : ''
  return `<g transform="translate(${x} ${y})"${glow}>${disc(T, look, motion)}${glyph ? glyph(glyphColor(T, look)) : ''}</g>`
}

/**
 * The orchestrator's circle, drawn larger than the design's (disc r 22, ring r 30) so its two lines
 * of text have room: disc r 32, ring r 43.6 (30 x 32/22). Strokes keep their widths; the ring and
 * the glow keep the design's proportions to the disc (a short graph shrinks all three: draw.ts orchCircleFor).
 */
export const ORCH_DISC_R = 32
/** The dashed ring's radius for a disc of radius `disc`. */
export const orchRingOf = (disc: number): number => (disc * 30) / 22
export const ORCH_RING_R = orchRingOf(ORCH_DISC_R)

/**
 * Node / Orchestrator (p1-5a06c): the dashed ring and the disc of radius `disc`, centred at (cx, cy).
 * In its own purple; in the needs-you colour and tint, as a needs-you card, when `needs`.
 */
export const orchestratorNode = (T: Tokens, cx: number, cy: number, ringClass: string, ringStyle: string, needs = false, disc = ORCH_DISC_R): string => {
  const [color, fill] = needs ? [T.needs, T.needsFill] : [T.orch, T.orchFill]
  const scale = disc / 22
  const ring =
    'M76.6151 45.846C76.6217 46.1049 76.625 46.3646 76.625 46.625C76.625 46.8854 76.6217 47.1451 76.6151 47.404M76.0414 40.7068C75.9394 40.1972 75.8245 39.6921 75.6971 39.1921M73.9886 34.3093C73.7754 33.8363 73.5502 33.3697 73.3136 32.9102M70.5579 28.5331C70.2451 28.12 69.9218 27.7152 69.5885 27.3191M65.9309 23.6615C65.5348 23.3282 65.13 23.0049 64.7169 22.6921M60.3399 19.9364C59.8803 19.6998 59.4138 19.4746 58.9407 19.2614M54.0579 17.5529C53.5579 17.4255 53.0528 17.3106 52.5432 17.2086M47.404 16.6349C47.1451 16.6283 46.8854 16.625 46.625 16.625C46.3646 16.625 46.1049 16.6283 45.846 16.6349M40.7068 17.2086C40.1972 17.3106 39.6921 17.4255 39.1921 17.5529M34.3093 19.2614C33.8363 19.4746 33.3697 19.6998 32.9102 19.9364M28.5331 22.6921C28.12 23.0049 27.7152 23.3282 27.3191 23.6615M23.6615 27.3191C23.3282 27.7152 23.0049 28.12 22.6921 28.5331M19.9364 32.9101C19.6998 33.3697 19.4746 33.8362 19.2614 34.3093M17.5529 39.1921C17.4255 39.6921 17.3106 40.1972 17.2086 40.7068M16.6349 45.846C16.6283 46.1049 16.625 46.3646 16.625 46.625C16.625 46.8854 16.6283 47.1451 16.6349 47.404M17.2086 52.5432C17.3106 53.0528 17.4255 53.5579 17.5529 54.0579M19.2614 58.9407C19.4746 59.4137 19.6998 59.8803 19.9364 60.3398M22.6921 64.7169C23.0049 65.13 23.3282 65.5348 23.6615 65.9309M27.3191 69.5885C27.7152 69.9218 28.12 70.2451 28.5331 70.5579M32.9101 73.3136C33.3697 73.5502 33.8362 73.7754 34.3093 73.9886M39.1921 75.6971C39.6921 75.8245 40.1972 75.9394 40.7068 76.0414M45.846 76.6151C46.1049 76.6217 46.3646 76.625 46.625 76.625C46.8854 76.625 47.1451 76.6217 47.404 76.6151M52.5432 76.0414C53.0528 75.9394 53.5579 75.8245 54.0579 75.6971M58.9407 73.9886C59.4137 73.7754 59.8803 73.5502 60.3398 73.3136M64.7169 70.5579C65.13 70.2451 65.5348 69.9218 65.9309 69.5885M69.5885 65.9309C69.9218 65.5348 70.2451 65.13 70.5579 64.7169M73.3136 60.3399C73.5502 59.8803 73.7754 59.4138 73.9886 58.9407M75.6971 54.0579C75.8245 53.5579 75.9394 53.0528 76.0414 52.5432'
  const shift = `translate(${cx} ${cy}) scale(${scale}) translate(-46.625 -46.625)`
  return (
    `<g transform="${shift}" style="filter:drop-shadow(0 0 ${Math.round(8 * scale * 10) / 10}px ${alpha(color, T.glowOrch)})">` +
    `<g class="${ringClass}" style="${ringStyle}"><path d="${ring}" vector-effect="non-scaling-stroke" stroke-width="1.25" stroke-linecap="round" stroke="${color}" stroke-opacity="0.55" fill="none"/></g>` +
    `<path d="M46.625 68.625C58.7753 68.625 68.625 58.7753 68.625 46.625C68.625 34.4747 58.7753 24.625 46.625 24.625C34.4747 24.625 24.625 34.4747 24.625 46.625C24.625 58.7753 34.4747 68.625 46.625 68.625Z" fill="${fill}" vector-effect="non-scaling-stroke" stroke-width="1.5" stroke="${color}"/>` +
    `</g>`
  )
}
