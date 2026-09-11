/**
 * Listing Lab — stager brief (virtual staging only).
 * A text/vision call acts as the interior stager: it looks at THIS room with
 * the customer's room type and style and writes a fresh, specific furnishing
 * brief — pieces, palette, materials, arrangement — so two living rooms in the
 * same style never come back from the same showroom. The customer never
 * writes a prompt; this is our system composing within fixed guardrails.
 */
const { geminiGenerateContent } = require('./gemini');
const { STAGING_STYLES, ROOM_TYPES } = require('./prompts');
const crypto = require('crypto');

/**
 * Variety is decided in code, not by the model. Each style has option pools;
 * a seeded draw fixes the sofa/anchor colour + silhouette, wood, metal, rug
 * and art for THIS job, and the stager must build around them.
 */
const POOLS = {
  Modern: { seatColor: ['warm white boucle', 'stone grey performance fabric', 'charcoal wool', 'camel leather', 'olive velvet', 'ink-blue linen', 'oatmeal boucle', 'black leather'], silhouette: ['low-profile track-arm', 'boxy block-arm', 'armless modular', 'slim-arm bench-seat'], wood: ['walnut', 'pale ash', 'smoked oak', 'black-stained oak'], metal: ['matte black', 'brushed steel', 'bronze'], rug: ['flat-weave wool in a tonal geometric', 'high-pile ivory shag', 'charcoal hand-knotted wool', 'natural jute with a black border', 'abstract-pattern wool in greys'], art: ['one large abstract canvas', 'black-and-white architectural photography', 'a minimal line-drawing print', 'a colour-field painting'] },
  Standard: { seatColor: ['slate blue chenille', 'cream linen', 'greige performance fabric', 'sage velvet', 'mushroom chenille', 'charcoal linen', 'camel leather', 'ivory boucle', 'navy velvet', 'warm taupe linen'], silhouette: ['English roll-arm', 'track-arm', 'bench-seat sock-arm', 'tuxedo', 'Lawson'], wood: ['oak', 'walnut', 'chestnut', 'ebonized', 'whitewashed oak'], metal: ['antique brass', 'brushed nickel', 'oil-rubbed bronze', 'polished nickel'], rug: ['vintage-look Persian in faded reds and blues', 'hand-knotted wool in ivory and grey', 'braided jute', 'striped flat-weave in navy and cream', 'distressed oushak in soft blues', 'tonal wool with a subtle trellis'], art: ['a framed landscape', 'botanical prints', 'a soft abstract', 'a large-scale seascape', 'a framed map'] },
  Contemporary: { seatColor: ['ivory boucle', 'terracotta velvet', 'rust mohair', 'forest green velvet', 'cobalt wool', 'black leather', 'sand linen'], silhouette: ['curved', 'modular low-slung', 'cloud-style deep-seat', 'channel-tufted'], wood: ['travertine-topped oak', 'smoked oak', 'black ash', 'pale maple'], metal: ['blackened steel', 'brushed brass', 'chrome'], rug: ['abstract wool in earth tones', 'cream high-pile', 'bold geometric flat-weave', 'irregular-shape shag'], art: ['a large abstract', 'sculptural wall piece', 'oversized photography', 'a bold colour-block canvas'] },
  Coastal: { seatColor: ['white slipcovered linen', 'sand linen', 'driftwood-grey woven', 'sea-glass blue cotton', 'navy linen', 'soft blue slipcover'], silhouette: ['slipcovered roll-arm', 'deep-seat track-arm', 'rattan-frame cushioned', 'bench-seat linen'], wood: ['light oak', 'whitewashed pine', 'rattan and cane', 'driftwood-finish'], metal: ['brushed nickel', 'rope and brass', 'white powder-coat'], rug: ['jute', 'seagrass', 'blue-and-white stripe flat-weave', 'ivory wool with a coastal pattern'], art: ['a seascape', 'botanical prints', 'abstract water painting', 'coastal photography'] },
  Luxury: { seatColor: ['ivory velvet', 'camel mohair', 'espresso leather', 'emerald velvet', 'navy velvet', 'burgundy mohair', 'black leather'], silhouette: ['tailored tuxedo', 'curved statement', 'deep bench-seat', 'channel-back'], wood: ['smoked oak', 'ebony lacquer', 'walnut burl', 'marble-topped'], metal: ['brass', 'bronze', 'polished nickel', 'gold'], rug: ['silk-blend hand-knotted in ivory', 'oversized wool in a tonal pattern', 'plush cream with a border', 'antique-look Persian'], art: ['oversized abstract', 'gallery-framed photography', 'a large figurative-free painting', 'a pair of tall canvases'] },
};

function drawChoices(style, seed) {
  const pool = POOLS[style]; if (!pool) return null;
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  const pick = (arr, i) => arr[h[i] % arr.length];
  return { seatColor: pick(pool.seatColor, 0), silhouette: pick(pool.silhouette, 1), wood: pick(pool.wood, 2), metal: pick(pool.metal, 3), rug: pick(pool.rug, 4), art: pick(pool.art, 5) };
}

async function writeStagingBrief(apiKey, imageB64, mime, model, roomType, style, layout, variantSeed, intent) {
  const { intentText } = require('./intent');
  const spec = ROOM_TYPES[roomType];
  const draw = drawChoices(style, variantSeed) || {};
  /**
   * A CHILD'S ROOM IS NOT A SMALL ADULT ROOM (11 Sep 2026). The seeded draw
   * hands the stager a sofa silhouette in an adult upholstery colour and an
   * adult art subject; applied to a nursery that produced a charcoal
   * upholstered twin bed under a figure line-art print — a guest room with a
   * basket. For this room type the anchor and art are drawn from children's
   * options instead, and the brief is told, in so many words, that the room
   * must be unmistakably a child's.
   */
  const kids = roomType === 'Nursery / Kids Room';
  if (kids) {
    const h = crypto.createHash('sha256').update(String(variantSeed)).digest();
    const pick = (arr, i) => arr[h[i] % arr.length];
    draw.silhouette = pick(['spindle crib', 'sleigh crib', 'low child-sized bed with a simple headboard', 'house-frame child bed', 'panel twin bed with a low headboard'], 0);
    draw.seatColor = pick(['soft white painted wood with a pale-blue-and-white patterned quilt', 'natural maple with a sunny yellow-and-white quilt', 'white painted wood with a mint-and-cream animal-print quilt', 'light oak with a blush-and-white star quilt', 'white wood with a rainbow-striped quilt'], 1);
    draw.art = pick(['framed watercolour animal prints', 'an alphabet poster and a small animal print', 'illustrated woodland animals', 'a hot-air-balloon print and a name banner', 'simple shape-and-colour prints for a child'], 5);
  }
  const prompt = `You are a professional interior stager writing the furnishing brief for ONE virtual-staging job. Look at the photo.

ROOM TYPE (fixed by the customer): ${roomType}. Anchor piece: ${spec.anchor}. Typical program: ${spec.program}. Never: ${spec.never}.${kids ? `
THIS IS A CHILD'S ROOM. It must be unmistakable at a glance to a parent scrolling a listing: children's bedding, children's art, toys visibly in the basket, picture books on a low shelf, a stuffed animal on the bed, a mobile over a crib. Never neutral "guest room" styling — no adult upholstered headboard, no grey or charcoal bedding, no abstract or figure line-art. Art subjects for this room are animals, letters, shapes, and illustration, not the adult categories listed below.` : ''}
STYLE (fixed by the customer): ${style} — ${STAGING_STYLES[style]}.
${layout ? require('./layout').layoutText(layout) : ''}
YOU are responsible for placement. Every piece you specify must sit outside every KEEP CLEAR box above, must not overlap any window, door, opening, fireplace, switch, or vent, and must not require changing any wall or opening. If the room is small or has many openings, specify fewer pieces. Never suggest closing, covering, or walling over an opening.
FIXED SELECTIONS FOR THIS JOB (already decided — build the brief around them, do not substitute):
- Main seating / anchor piece: ${draw.silhouette} silhouette in ${draw.seatColor}
- Wood tone: ${draw.wood}; metal finish: ${draw.metal}
- Rug: ${draw.rug}
- Art: ${draw.art}
Choose the remaining pieces, palette and accessories to work with these selections and with the room's wall colour and flooring.${intentText(intent)}
${intent && intent.accepted && intent.accepted.wantPieces.length ? 'If a client-requested piece conflicts with the fixed anchor selection, the client piece wins for that slot (e.g. a sectional replaces the sofa) but keeps the fixed colour/material.' : ''}

FIRST, identify the room's FOCAL POINT in this photo (fireplace > TV wall > best window/view > longest uninterrupted wall, in that order) and state it. The main seating MUST face that focal point: the sofa's back to the opposite side of the room, armchairs flanking at an angle so the group forms a conversation area around the coffee table, with the rug under the whole grouping. Never put the sofa's back to the focal point, never leave a sofa parallel to a window wall with nothing to face, never scatter chairs that face empty floor. Give each piece its position as a percent-of-frame box (x_from–x_to, y_from–y_to) and what it faces. Describe the ORIENTATION of the sofa in camera-relative terms an image renderer understands, e.g. "sofa with its BACK toward the camera, seat facing the fireplace on the back wall" or "sofa along the left wall, seat facing right toward the fireplace". If the focal point is on the back wall, the sofa's back is toward the camera.

Write a brief a photorealistic renderer will follow. Be concrete: name each piece with its silhouette, upholstery/material, and color (e.g. "a 84-inch track-arm sofa in charcoal performance linen", not "a sofa"); choose a palette of 3 colors and one accent; choose wood tone and metal finish; choose the rug (material, pattern, color); choose art subject matter (abstract / landscape / botanical / photography, never people); choose 2–3 accessories. Respond to the room: its wall color, flooring, light, window positions, and what fits its size. Keep a stager's restraint — at most 6 furniture pieces plus rug, art, and 2–3 accessories. Respect every rule about doors, windows, switches, and vents.

THE CONCEPT DESCRIBES FURNITURE, NEVER LIGHT OR CAMERA. This photograph's daylight, exposure, and framing are fixed facts the renderer must not touch, so your concept must not invite it to: never use words like "editorial", "moody", "dramatic", "ambient", "evening", "glow", "cinematic", or "atmosphere". A concept that sets a mood gets rendered as a relight, and a relit photo is thrown away. Name the furniture story ("tailored camel mohair with walnut and brass"), not a mood.

Respond with ONLY JSON:
{"focalPoint":"what it is and where in the frame","arrangement":"one sentence: how the grouping is oriented to the focal point","concept":"one sentence naming the look","palette":["...","...","..."],"accent":"...","wood":"...","metal":"...","pieces":["piece with material+color+placement", ...],"rug":"...","art":"...","accessories":["...","..."]}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: imageB64 } }] }],
    generationConfig: { temperature: 1.0, response_mime_type: 'application/json' },
  };
  const json = await geminiGenerateContent(apiKey, model, body);
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  try { return { draw, ...JSON.parse(text) }; } catch { return null; }
}

function briefText(b) {
  if (!b || !b.pieces) return '';
  return `\n\nSTAGER'S BRIEF for this room (follow it — these are the exact pieces to place):
Focal point: ${b.focalPoint || 'as specified'}
Arrangement (mandatory): ${b.arrangement || 'main seating faces the focal point as a conversation group'}
Concept: ${b.concept}
Palette: ${(b.palette || []).join(', ')}; accent ${b.accent}; wood ${b.wood}; metal ${b.metal}.
Pieces:\n${b.pieces.map(p => '- ' + p).join('\n')}
Rug: ${b.rug}
Art: ${b.art}
Accessories: ${(b.accessories || []).join('; ')}`;
}

module.exports = { writeStagingBrief, briefText, drawChoices, POOLS };
