/**
 * Listing Lab — canonical transformation prompts for Nano Banana Pro
 * (gemini-3-pro-image). These are the ONLY prompts the system ever sends.
 * The customer never writes a prompt; they pick a transformation + options,
 * and the backend assembles the prompt from this closed set.
 *
 * These same strings ship to the Cloudflare Worker unchanged.
 */

const { APPLIANCE_RULE } = require('./scope');

/* Shared preservation contract — prepended to every transformation. */
const PRESERVATION = `You are the automated finishing engine of a professional real-estate photography studio. You edit one MLS listing photograph.

ABSOLUTE RULES — the property must remain truthful:
- Preserve the architecture exactly: walls, ceilings, floors, windows, doors, trim, stairs, railings, built-in cabinetry, counters, fixtures, fireplaces, and room proportions.
- Preserve the camera: same viewpoint, lens geometry, perspective lines, and framing. Do not crop, rotate, or extend the image.
- Preserve materials and finishes: flooring, paint, tile, and countertop surfaces stay identical unless a rule below explicitly allows a change.
- Photorealism only: match the original photo's lighting direction, white balance, grain, and depth of field. The result must be indistinguishable from a professional photograph.
- Never add people, animals, text, logos, watermarks, brand names, or readable screens.
- Never change what the property IS — only what this transformation explicitly permits.
- ${APPLIANCE_RULE}`;
// A "don't copy the old corner watermark" rule used to live here (31 Aug
// 2026) after a chained staging redrew the input's stamp under the fresh one.
// It was removed the same night — the bench showed it PRIMED the model into
// returning empty-room jobs untouched ("nothing was removed"), three straight
// production rejections. The double-stamp problem is solved mechanically
// instead: chained edits start from the stored pre-watermark clean frame
// (see photoFromJob in the Worker), so the model never sees a stamp at all.

const STAGING_STYLES = {
  Modern: 'MODERN — clean lines and restraint. Choose among: low-profile or boxy sofas in performance fabric, leather, or boucle; colors from warm white, stone, charcoal, camel, olive, ink; accents in matte black, walnut, or pale ash; sculptural or linear lighting; one large abstract or photographic art piece; minimal styling.',
  Standard: 'STANDARD — the broadly appealing default: classic shapes with contemporary restraint, chosen to suit almost any home. Choose among: rolled-arm, track-arm, English-arm, or bench-seat sofas; upholstery in linen, chenille, velvet, or leather; colors from cream, greige, taupe, slate blue, sage, mushroom, charcoal, camel; wood in oak, walnut, chestnut, or ebonized finishes; framed landscape, botanical, or soft abstract art; layered but edited textures.',
  Contemporary: 'CONTEMPORARY — of-the-moment. Choose among: curved or modular sofas, boucle, mohair, smoked glass, travertine, brushed or blackened metal; colors from ivory, terracotta, rust, forest, cobalt, black; statement lighting; curated sculptural decor; one confident accent color.',
  Coastal: 'COASTAL — light and breezy. Choose among: slipcovered, linen, or woven seating in white, sand, driftwood, sea-glass, navy, or soft blue; light oak, rattan, cane, rope, and whitewashed finishes; jute, seagrass, or striped rugs; seascape, botanical, or abstract-water art.',
  // "designer, editorial" was the old opening, and it cost real deliveries —
  // every failed Luxury brief on 31 Aug 2026 began "Editorial luxury…" and the
  // renders came back dimmed into moody evening light with widened framing,
  // magazine drama the compliance checks exist to refuse. Luxury here is
  // MATERIALS, never mood.
  Luxury: 'LUXURY — high-end designer furnishings. Choose among: tailored statement sofas in velvet, mohair, or fine leather; marble, brass, bronze, lacquer, smoked oak; colors from ivory, camel, espresso, emerald, navy, burgundy, black; oversized art; designer floor and table lamps (switched OFF, styling only); layered rich textiles. LUXURY IS THE FURNITURE, NOT THE LIGHT: the photograph keeps its own bright daylight, exposure, and exact framing. Never dim the room, never add glow or mood, never widen the view — a luxury-staged real-estate photo is still a bright real-estate photo that happens to contain exceptional furniture.',
};

// One twilight look only (Kyle, 27 Aug 2026). Golden Hour and Blue Hour were
// retired from the product AND the pipeline — a single, consistent dusk is what
// we produce and what the compliance judge is tuned for.
const TWILIGHT_MOODS = {
  'Dusk': 'a few minutes after sunset: the sky deepening to blue overhead, streaked with pink-orange clouds, a warm orange glow along the horizon',
};

/**
 * Closed list of room types the customer can pick. Each carries the furniture
 * program a stager would use, so the model is told WHAT to put in the room,
 * not just the room's name. The judge checks the result against this too.
 */
const ROOM_TYPES = {
  'Living Room': { anchor: 'a sofa (plus a loveseat or pair of armchairs as space allows)', program: 'sofa, accent chair(s), coffee table, area rug, side/end table with lamp, console or media unit only if a wall clearly suits it, wall art, a plant', never: 'a bed, dining table, desk, or crib' },
  'Dining Room': { anchor: 'a dining table with chairs, centered on the room/fixture', program: 'dining table with 4–8 chairs sized to the room, area rug under the table, a sideboard or buffet only if a wall clearly suits it, a centerpiece, wall art', never: 'a sofa, bed, desk, or sectional' },
  'Primary Bedroom': { anchor: 'a queen or king bed with headboard on the longest uninterrupted wall', program: 'bed with headboard and layered bedding, two nightstands with lamps, a dresser or bench only if space allows, area rug, wall art above the bed, a plant', never: 'a sofa, dining table, desk as the main piece, or crib' },
  'Guest Bedroom': { anchor: 'a full or queen bed with headboard on the longest uninterrupted wall', program: 'bed with headboard and bedding, one or two nightstands with lamps, a small dresser or chair if space allows, area rug, wall art', never: 'a sofa, dining table, or sectional' },
  // Rewritten 11 Sep 2026 after Kyle saw a delivery that met the old program
  // to the letter (twin bed, rocker, rug, art, basket) and still read as an
  // adult guest room — grey upholstered bed, figure line-art, empty rope
  // basket. "This is not a kids room nursery." A child's room has to be
  // unmistakable at a glance, so the cues are named and adult styling is
  // banned outright. (Keep colon-space out of these comments.)
  'Nursery / Kids Room': { anchor: 'a crib with a mobile hanging above it (nursery), or a child-sized bed dressed in clearly children\'s bedding (kids room), on the longest uninterrupted wall', program: 'crib or child-sized bed with children\'s bedding (a colourful or patterned quilt with a stuffed animal on it), a dresser or changing table, a rocking chair or small reading chair, a soft playful rug, children\'s wall art (animals, letters, shapes, a name banner), a low bookshelf with picture books, a toy basket with toys visibly in it — the room must read as a child\'s room at a glance, with at least three unmistakable child cues clearly visible', never: 'adult-styled bedroom furniture — an upholstered adult headboard, grey or charcoal adult bedding, abstract or figure line-art, neutral guest-room styling — or a sofa, dining table, desk, or adult king or queen bed' },
  // Rewritten 31 Aug 2026 after Kyle saw a sofa-and-coffee-table delivery —
  // "If you're doing basement and rec room, there should be dartboards, pool
  // tables, not a couch." The room is sold as a place to PLAY — games lead,
  // seating supports. (Keep colon-space out of these comments — the parity
  // test's key regex would read one as a phantom room type.)
  // Kyle, 1 Sep 2026, on a delivery with a couch and wall art — "A basement
  // rec room should be more of a man cave. I see no games there. Needs games."
  // Games ARE the room. Seating supports; a couch-led arrangement fails.
  // (1 Sep 2026, second pass — the mandatory TV media wall made the model
  // DELETE a door to clear wall space in a small basement; three candidates
  // refused for exactly that. The TV is optional now; the games are not.)
  'Basement / Rec Room': { anchor: 'GAMES ARE THE ROOM — a man-cave. The centerpiece is a game: a pool table, a poker/card table with chairs, or a foosball table, whichever the floor space honestly allows; and a dartboard hangs on a genuinely free stretch of wall in EVERY arrangement, no exceptions. The existing walls, doors, switches, and built-ins stay exactly as they are — the games move in AROUND them', program: 'a pool, poker, or foosball table sized honestly to the room (the centerpiece, always present), an unbranded dartboard with no readable text or logos anywhere on it, on a free wall area (always present), bar stools pulled up to any existing bar or counter, game-and-sport wall decor with NO readable text or logos (abstract sports art, text-free vintage-style prints) where a wall is genuinely free, a dark-screened TV on a media console ONLY if an uninterrupted wall truly fits one without covering or replacing anything, a compact sofa or a pair of recliners as SUPPORTING seating only, area rug, floor lamp', never: 'a bed, dining table, or crib — and never a seating-first arrangement: if the staged room reads as a living room rather than a game room, it is wrong' },
  'Home Office': { anchor: 'a desk with a task chair, positioned to face into the room or toward the window light', program: 'desk, task chair, a bookcase or shelving, a desk lamp, a small rug, wall art, a plant', never: 'a bed, sofa, dining table, or crib' },
  'Other': { anchor: 'furniture matching the room\'s obvious function', program: 'a restrained grouping matching whatever the room is clearly for', never: 'any furniture that contradicts the room\'s obvious function' },
};

const { clutterLine, keeperLine } = require('./scope');

/**
 * DECLUTTER — written as a copy job with exceptions, not a tidying job with rules.
 *
 * WHAT WAS WRONG WITH THE OLD SHAPE
 * It opened with "Remove movable clutter only" and then spent twelve bullets
 * fencing that in, with the catalogued keep list last. That is a PERMISSIVE
 * frame: it tells the model to go and tidy, then argues about how far. The model
 * read it the way the sentence is built and tidied. Measured on real photographs
 * on 26 Aug 2026, with every one of those bullets already in place:
 *
 *   k-office   removed "the small dark brown wooden cabinet" — on the keep list
 *              — twice, and on the second attempt invented a light switch too
 *   bedroom1   removed "the black office chair at the bottom left edge", a chair
 *              half out of frame, despite an explicit frame-edges rule
 *
 * Both are furniture. The old prompt said "Furniture is NEVER clutter" in bullet
 * seven of twelve. Saying it louder was not going to work; the frame had to
 * change.
 *
 * THE SHAPE NOW
 * Copy the photograph. Then delete a short, closed list of things from the copy.
 * Everything not on that list is not a decision the model gets to make — which
 * is also exactly how Kyle described the job: *"Only personal clutter."*
 *
 * The catalogued keep list moves to the TOP, because it is the specific,
 * photograph-level instruction and the generic rules are only there to catch
 * what the catalogue missed.
 */
function declutterPrompt(inventory, fixedElements) {
  const keepList = inventory && inventory.keep && inventory.keep.length
    ? `\n\nCATALOGUED IN THIS PHOTOGRAPH — every one of these is present now and must be present, unmoved and unchanged, in your output. This list overrides every general rule below. If clutter is sitting on or against one of these, remove the clutter and reconstruct the item underneath it as ONE continuous piece with exactly the outline its visible parts imply — a sectional stays joined to its chaise, a sofa keeps its arms and seats, a table its legs; never split, shorten, float or re-model a piece because a cover hid part of it:\n${inventory.keep.map(k => '- ' + k).join('\n')}\n`
    : '';
  const lightList = inventory && inventory.lights && inventory.lights.length
    ? `\n\nLIGHT STATES (do not change): ${inventory.lights.map(l => `${l.fixture}: ${l.state}`).join('; ')}.`
    : '';
  /**
   * THE CLUTTER CATALOGUE, HANDED TO THE GENERATOR (5 Sep 2026). The judge has
   * been sweeping by this catalogue since 4 Sep and the number-one failure it
   * finds is still "clutter left" — 179 of 344 masked-path violations in the
   * 2–4 Sep production audits. The generator was never shown the list; it was
   * told the categories and left to find the items. Now it gets the same
   * catalogue the judge will hold it to, item by item and where each stands.
   * DECLUTTER_LIST_IN_PROMPT=0 restores the category-only prompt.
   */
  const removeList = process.env.DECLUTTER_LIST_IN_PROMPT !== '0' && inventory && Array.isArray(inventory.clutter) && inventory.clutter.length
    ? `\n\nCATALOGUED CLUTTER IN THIS PHOTOGRAPH — remove EVERY item on this list, completely, and rebuild the surface behind each. This is the checklist your output will be inspected against, item by item; an item still visible, or half-visible, fails the whole photograph:\n${inventory.clutter.map(c => '- ' + c).join('\n')}\nThe list may be incomplete: anything else that fits the clutter categories below goes too.\n`
    : '';
  /**
   * THE OPENINGS (5 Sep 2026): the generator "decluttered" a bedroom seen
   * through a doorway (blue walls to beige, bed gone) and turned a round
   * wall cutout into a mirror — both passed the judges and were caught by
   * the through-the-openings review. Now it is told, by name, which
   * openings exist and that what lies beyond each is part of the building.
   */
  const openings = (fixedElements || []).filter(f => /doorway|door|window|opening|arch|pass-?through|stair/i.test(`${f.kind} ${f.name}`)).map(f => f.name).slice(0, 8);
  const openingList = openings.length
    ? `\n\nOPENINGS IN THIS PHOTOGRAPH — ${openings.join('; ')}. Each opening, and EVERYTHING SEEN THROUGH IT, is part of the building and stays exactly as photographed: the same room or view beyond, its wall colour, floor, doors, fixtures and furniture in place, the same daylight and scenery through a window. An opening is never filled in, covered, or swapped for a mirror, picture or ornament, and a wall never gains one. Loose personal items visible through an opening are removed like any other clutter; nothing else beyond it changes.`
    : '';
  return `${PRESERVATION}

TRANSFORMATION: DECLUTTER.

Your output is a COPY of this photograph with a short list of small personal items deleted from it. It is not a redecoration, a tidy-up, or a staging. Every pixel that is not one of those items, or the surface directly behind one, is unchanged.
${keepList}${openingList}${removeList}
DELETE ONLY THESE, and nothing else in the photograph:
- ${clutterLine()}

That list is the whole of what may be deleted. If an object is not on it, it stays — no matter how much better the room would look without it, no matter how out of place, worn, cheap, or oddly positioned it is. You are not being asked whether the room looks good. You are being asked to delete personal clutter.

EMPTY THE SHELVES, KEEP THE SHELVES. Shelving units, bookcases, cubbies and wall shelves stay exactly as built — but the PERSONAL BELONGINGS filling them go: toys, stuffed animals, supplies, containers, bins and boxes, knickknacks, the lot, shelf by shelf until the shelves read clean. What stays on a surface is only clearly intentional styling — potted plants, a vase, a decorative tray or candle. A shelf packed with a family's things is clutter ON furniture: remove the things, rebuild the empty shelf faces cleanly, and do not move, resize, or redraw the unit itself.

ALL OR NOTHING, EVERY SINGLE ITEM. Remove an item COMPLETELY — every part of it, its shadow, and any cable that belongs to it alone — and rebuild a clean, plausible surface where it stood. If an item cannot be removed cleanly, leave it COMPLETELY untouched instead. There is no third option: a half-erased object, a smear, a faint outline, or a wavy remnant of a cord is the worst possible output — worse than leaving the item alone. Cables that belong to something that STAYS (a television on the wall, a lamp in use) are part of that item: they stay, pixel for pixel, crisp.

FURNITURE IN USE IS NEVER CLUTTER AND IS NEVER DELETED. Not chairs, cabinets, tables, shelves, nightstands, benches, stools, desks, or dressers. Not a chair that looks out of place. Not a cabinet in a corner. If you are unsure whether something is furniture, it is, and it stays.

CLUTTER SITS ON FURNITURE — REMOVE THE CLUTTER, KEEP THE FURNITURE. This is the single most common and most serious mistake, so read it twice. When personal items sit ON a table, desk, dresser, shelf, or cabinet, you remove ONLY the items and leave the piece of furniture exactly where it is, same size, same shape, same position, its now-clear surface reconstructed. You do NOT remove the table to clear the things on it. Watch three cases especially: (1) a GLASS-TOP or clear/acrylic coffee, side, or dining table — because you can see through it, it is the easiest to erase by accident; it stays. (2) a coffee table or ottoman in the CENTRE of a seating group — it anchors the room and it stays. (3) a desk with a computer, monitor, laptop, keyboard or TV on it — the desk AND those electronics stay; they read as a working home office, and clearing them empties a room the seller has not emptied. Removing a piece of furniture to tidy what was on top of it is a failure exactly as serious as deleting a sofa.
The one exception is furniture that is NOT IN USE but STORED: a mattress or box spring standing on its edge against a wall, a bed frame or table in pieces, a table folded flat, chairs stacked in a corner, a headboard leaning behind a door, a wall mirror or framed picture set down on the floor against a wall instead of hung (a tall full-length floor mirror made to lean is styling and stays). That is not furnishing the room, it is being kept in the room, and it goes out with the seller — delete it. Furniture standing on its feet and doing its job stays, even when pushed right up against a wall.

THE TEST FOR ANYTHING ELSE IS WHETHER IT CONVEYS WITH THE HOUSE. Fitted to the building — a window air conditioner, a baseboard heater, a radiator, a ceiling fan, a wall-mounted unit, an outlet, a switch, a vent — the buyer is getting it, so it STAYS. Free-standing and the seller takes it with them — a box fan or floor fan, a space heater, a dehumidifier, an air purifier, a vacuum cleaner, a drying rack — it is their belongings, so it GOES.

STYLING STAYS TOO, even though it is movable: ${keeperLine()}. A vase, a folded towel and a decorative tray are STYLING and stay. A trash can, a soap bottle and a hairbrush are CLUTTER and go — a bin left beside a toilet is the single most common miss.

PLACEMENT DECIDES STYLING VS CLUTTER. The same object can be either. A throw folded on a sofa arm or a vase on a shelf is intentional styling and stays; that throw jumbled in a heap across the seat, belongings piled on the cushions, or that vase sitting on the floor where it belongs on a surface is a mess the seller left, and it goes. When soft goods or objects are clearly heaped, piled, or dumped out of place, remove the mess and reconstruct the clean surface underneath.

BE THOROUGH. A finished declutter has NO personal clutter left anywhere — not on the floor, not heaped on a sofa seat or chair, not on a desk, dresser, counter or windowsill. Sweep the whole frame: the floor, every seat, and every surface. Leaving one obvious item behind is as much a failure as removing something you should not.

CLOSETS, LAUNDRY AREAS AND UTILITY SPACES get exactly the same strict treatment, and they are where partial jobs happen most (beta, 31 Aug 2026: every closet and laundry declutter was refused for items left behind). In these rooms:
- HANGING CLOTHES ARE CLUTTER. Every garment hanging on a rod, hook, or the back of a door goes — all of it, and the empty hangers too. The rod, its brackets, hooks, and the shelving stay exactly as built. Where the clothes hung, reconstruct the wall and shelving behind them cleanly and completely — a half-erased garment or a smudged wall is a failure.
- THE SHELF WALL GOES TOO: detergent and cleaning bottles, jugs, spray cans, boxes of pods or sheets — every container on the shelves above or beside the machines. The shelves themselves stay.
- Laundry baskets and hampers (full or empty), drying racks, ironing boards, portable fans and dehumidifiers, and loose papers or boxes on top of cabinets: all of it goes.
- The washer, dryer, sink, cabinets, countertops and every built-in stay exactly as photographed.
Sweep these small rooms surface by surface — shelf by shelf, the rod, the machine tops, the floor — before you finish. In a two-metre room a single leftover bottle is the whole job failed.

THE ONLY DIFFERENCE between the input and your output is that the listed items are gone. In particular:
- Add NOTHING. No rugs, lamps, plants, pillows, art, nightstands, outlets, or switch plates. Inventing a light switch on a bare wall is a failure exactly as serious as deleting a chair.
- Where a removed item revealed a surface, reconstruct that surface exactly as it plausibly is — same flooring, same countertop, same wall. Clean, not redesigned.
- Bedding and upholstery keep their existing fabric, pattern and colour. You may smooth and straighten them. You may not add a blanket, throw, pillow or cover that was not there.
- LIGHTING STAYS AS PHOTOGRAPHED: every lamp and ceiling fixture keeps its exact on/off state and brightness. Do not switch any light on or off, do not brighten the room, do not change the exposure or white balance. Window views stay identical.
- FRAME EDGES: anything cut off by the edge of the photograph stays cut off in exactly the same way. Never complete, extend or redraw a partially visible object — if only the corner of a chair or a desk is visible, output that same corner. A partially visible object is still an object that stays.${lightList}

Output the same room, with the same furniture, in the same light, with the personal clutter gone.`;
}

function stagingPrompt(style, roomType, layout, brief) {
  const { layoutText } = require('./layout');
  const { briefText } = require('./brief');
  const styleSpec = STAGING_STYLES[style];
  if (!styleSpec) throw new Error(`Unknown staging style: ${style}`);
  const spec = ROOM_TYPES[roomType];
  if (!spec) throw new Error(`Unknown room type: ${roomType}`);
  const room = roomType === 'Other' ? 'room' : roomType.toLowerCase();
  return `${PRESERVATION}

TRANSFORMATION: VIRTUAL STAGING.
${brief && brief.arrangement ? `ARRANGEMENT (the most important instruction in this prompt): ${brief.arrangement} Focal point: ${brief.focalPoint || ''}. Seating must be oriented so a person sitting on it looks at the focal point. Seating must also be PULLED IN CLOSE to it: the sofa, chairs, coffee table and rug form one tight conversation group gathered around the focal point at normal living distance — close enough that someone on the sofa could comfortably watch the television or feel the fire. Do NOT leave the grouping marooned in the middle or far end of the room with a wide empty floor gap between it and the focal point. A real stager pulls the furniture toward the fireplace or media wall, not away from it.

` : ''}The customer has told us this room is a ${roomType.toUpperCase()}. Stage it ONLY as a ${room} — this is not negotiable, regardless of what the space might also suit.
- Anchor piece: ${spec.anchor}.
- Furniture program (use what fits; omit pieces the space cannot take): ${spec.program}.
- NEVER place: ${spec.never}.
Style: ${styleSpec}.
- Furniture must sit correctly on the floor plane with accurate scale, perspective, contact shadows, and reflections consistent with the room's light.
- SCALE TO REAL LIFE — measure against the fixed elements in the photo: a doorway is about 36 inches / 91 cm wide, a wall outlet sits about 12 inches off the floor, a window sill is about knee-to-hip height. Size every piece to those rulers: a full sofa is about 7 feet long, a bed queen or king. NEVER shrink furniture to make the room look bigger — undersized pieces floating in a too-large room misrepresent the listing and read as fake. When in doubt, go slightly larger, as a real home would.
- ORIENT SEATING TO THE FOCAL POINT — find the room's natural focus (a fireplace, a TV or media wall, or the primary window/view) and turn the main seating so a person sitting on it faces that focus. A sofa with its back to the fireplace, or facing a blank wall, is the mistake to avoid.
- ANCHOR, DON'T FLOAT — place large seating against or near a wall the way a real room is furnished, and gather the sofa, chairs, coffee table and rug into one tight group at comfortable conversation distance. Do not strand furniture marooned in the middle of the room with a wide empty floor gap around it. Keep clear walking paths through the room.
- Arrange for the ${room}'s obvious function and traffic flow; do not overcrowd — a professional stager's restraint.
- Never block or overlap windows, doors, doorways, light switches, thermostats, built-ins, or fireplaces; never hang anything that alters the wall itself. (Furniture standing in front of a wall OUTLET is normal and fine.)
- Baseboard heaters and radiators: furniture may stand in front of them as it would in a real home, but must not be pushed against or covering them — leave a visible gap so they remain partly visible.
- DOORS AND CIRCULATION: every door in the photo (entry doors, interior doors, closet doors) must be fully visible AND fully usable. Leave the entire door-swing zone — a clear floor area at least as deep as the door is wide, directly in front of every door — completely empty. No sofa end, chair, table, plant, or rug pile may sit in that zone. Keep an obvious, unobstructed walking path from each door into the room and between the room's openings.
- Keep the full original frame: every door, window, fixture, and wall edge in the photo must still be visible in the result.
- EVERYTHING ALREADY IN THE PHOTOGRAPH STAYS. Any object the photo already contains — framed art or prints resting on a mantel or shelf, existing decor, vases, plants, books — remains exactly where it is, unchanged. Staging ADDS around what is there; it never removes, replaces, or restyles a single existing object. If the mantel already has art on it, that art is still there in your output, and you do not add competing art beside it.
- Existing window treatments (curtains, rods, blinds, shades) stay exactly as photographed — never replace, remove, or restyle them. Existing ceiling fixtures keep their on/off state.
- Decor must be anonymous: no framed photographs of people, no faces in art, no readable text.
- Do not change flooring, wall color, trim, lighting fixtures, or any part of the property. The ONLY additions are freestanding furniture, rugs, art leaning or hung without altering the wall structure, plants, and decor.
${layoutText(layout)}${briefText(brief)}
Output the same ${room}, beautifully staged.`;
}

const TWILIGHT_HEADER = `You are the automated finishing engine of a professional real-estate photography studio. You convert one daytime MLS exterior photograph into the same photograph taken at twilight.

ABSOLUTE RULES — the property must remain truthful:
- Preserve the architecture exactly: roofline, siding, stone, every window and its grille pattern, every door (including storm and garage doors), shutters, columns, railings, steps, walkways, driveway, fence.
- Preserve EVERY real structure in the frame, not only the subject house: neighboring houses, distant rooftops, garages, sheds, fences, poles, and any building visible anywhere — including small ones along the top edge and, in an aerial view, the rows of houses that fill the upper part of the frame. All of them stay exactly where they are.
- The replacement sky goes ONLY where there was open sky in the original. Never paint sky over a real building, rooftop, tree, or any real content to "open up" the frame. If the original has little or no visible sky — a tight aerial packed with rooftops and trees — then little or no new sky appears; you relight what is there and do NOT carve out sky by erasing real structures.
- Preserve the camera: same viewpoint, lens geometry, perspective lines, and framing. Do not crop, rotate, straighten, zoom, rescale, or extend the image.
- Preserve the landscaping: every tree, shrub, bed, rock, and lawn contour, including branches that overlap the sky.
- Photorealism only: keep the original's sharpness, grain, and depth of field. The result must be indistinguishable from a real twilight photograph.
- Never add people, animals, text, logos, or watermarks. Never invent windows, doors, or light fixtures.`;

function twilightPrompt(mood, manifest) {
  const moodSpec = TWILIGHT_MOODS[mood];
  if (!moodSpec) throw new Error(`Unknown twilight mood: ${mood}`);
  return `${TWILIGHT_HEADER}

TRANSFORMATION: TWILIGHT CONVERSION — in the style of a professional real-estate twilight shoot.
Relight the ENTIRE scene for that time of day — sky, house, lawn, trees, driveway — with the home's lights on. You have full freedom over exposure, color, and mood; the only hard constraint is that nothing about the property changes. Match this description exactly:

SKY: ${moodSpec}. Replace ONLY the sky that is already open in the original with this. Keep clouds natural and soft-edged. The sky goes BEHIND everything real: every branch, leaf cluster, and canopy that overlaps the sky — especially along the top edge and in the corners — AND every real structure behind or beside the house: neighboring homes, distant rooftops, background buildings. All of it stays at exactly the same size, shape, and position, simply relit for dusk. Do not thin, shrink, shorten, or redraw overhanging branches; do not let any tree grow taller or denser; and never erase a real building or rooftop to enlarge the sky. If the frame is a dense aerial with almost no open sky, then almost no new sky appears — you do not manufacture it by painting over the neighborhood.

LIGHT ON THE SCENE: the sun is below the horizon, so the light is soft, even, and directionless — no hard-edged cast shadows anywhere (lawn, driveway, foundation, siding, under eaves), no sunlit patches, no dappled tree shadows. Expose the scene BRIGHT and crisp — only moderately darker than the daytime frame. The house, lawn, and trees stay clearly lit and legible with natural colour; the lawn stays a true green with its texture (including any brown patches), never muddy or dark. Sky: pink-orange clouds over blue, not a heavy violet/purple cast over everything. The result should read as a crisp, richly saturated, well-processed twilight, not a dark or moody night scene.

WINDOWS: every window that exists in the original is lit from inside with a warm (2700K) translucent glow — the glass still reads as glass, with grilles, blinds, and a hint of interior visible through it, not an opaque yellow fill. Vary the brightness naturally between windows; a few can be dimmer. The glow spills softly onto the trim and siding immediately around each window. Never invent a window or a door light.

FIXTURES: turn on the fixtures that exist in the original${manifest && manifest.fixtures && manifest.fixtures.length ? ` — specifically: ${manifest.fixtures.join('; ')}` : ' — porch/garage lanterns, wall sconces, landscape/path lights along the foundation and beds'} — as warm points with a soft pool of light on the surface next to them.${manifest && manifest.landscapeLights === false ? ' There are NO landscape or path lights on this property; do not add any.' : ''} Do not add fixtures that are not there.${manifest && manifest.description ? `

KEEP EXACTLY AS PHOTOGRAPHED — this property: ${manifest.description} Do not move, resize, add, or remove any structure, window, door, or fixture.` : ''}

COLOR: sky warm at the horizon, cool above; the scene takes on the ambient color naturally — cooler in the shadows, warmer near the lit windows and fixtures — without a heavy single-color cast.

Output the same photograph, same framing, at twilight.`;
}

/** Stage 1 of twilight: neutralise the sun before relighting. */
function overcastPrompt() {
  return `${PRESERVATION}

TRANSFORMATION: OVERCAST NEUTRALISATION (intermediate step).
Re-render this exact exterior photograph as if taken on a uniformly overcast day, sun fully hidden:
- Remove EVERY direct-sun shadow: on the lawn, driveway, walkway, foundation, siding, under the eaves, under the shrubs, on the steps. Remove every bright sunlit patch and every dappled tree-shadow pattern on the grass. The lawn becomes one even, medium green with only gentle tonal variation from the ground itself.
- Remove sun glare and hot highlights from the roof, windows, shutters, and railings.
- Replace the blue sky with a flat, even, pale grey overcast sky, keeping every branch and leaf silhouette exactly where it is.
- Lighting becomes soft and directionless; the only gradient is surfaces facing the sky being slightly brighter.
- Colors stay natural and neutral; do not make it dramatic. Do not change anything else about the property, landscaping, or framing.
Output the same photograph on a flat overcast day.`;
}

/** EMPTY ROOM: remove everything movable; keep the property itself untouched. */
function emptyPrompt(inventory) {
  const fixedList = inventory && inventory.keep && inventory.keep.length
    ? `\n\nFIXED ELEMENTS catalogued in this photo — every one MUST remain exactly as photographed:\n${inventory.keep.map(k => '- ' + k).join('\n')}`
    : '';
  const lightList = inventory && inventory.lights && inventory.lights.length
    ? `\nLIGHT STATES (do not change): ${inventory.lights.map(l => `${l.fixture}: ${l.state}`).join('; ')}.`
    : '';
  return `${PRESERVATION}

TRANSFORMATION: EMPTY THE ROOM COMPLETELY.
Remove EVERY movable object so the room is completely vacant, as if the owners moved out and the room was professionally cleaned:
- Remove: all freestanding furniture (beds, sofas, chairs, stools, tables, desks, dressers, nightstands, shelves, benches), rugs, lamps, fans, mirrors leaning on walls, wall art and photos (hung or leaning), plants, electronics that are not wall-mounted, boxes, clothing, bedding, decor, and every piece of clutter.
- KEEP (these are part of the property): curtains, drapes, blinds and their rods; wall-mounted TVs and their mounts; ceiling fixtures and fans; built-in shelving and cabinetry; radiators, baseboard heaters, window AC units; outlets, switches, vents, thermostats, smoke detectors; door hardware; AND EVERY MAJOR APPLIANCE — the refrigerator, range/stove, cooktop, wall oven, range hood, dishwasher, built-in microwave, washer and dryer stay exactly where they are, in a kitchen or laundry emptied of everything else. Clearing a kitchen means clearing the counters and floor, never the appliances.
- BUILT-INS KEEP THEIR EXACT CONSTRUCTION, shelf by shelf and door by door (beta, 31 Aug 2026: emptied rooms were refused for exactly these inventions). An open shelf stays an open shelf — NEVER add cabinet doors, panels, or backs that are not in the photograph. A closed cabinet keeps its doors. You empty the shelves' CONTENTS; you never redesign the unit. A wall-mounted TV is part of the property and stays on its mount.
- WHERE A BUILT-IN IS PARTLY HIDDEN behind something you are removing (a lamp, a plant, furniture), reconstruct the hidden part by CONTINUING that unit's nearest VISIBLE section at the same height: the same shelf spacing, the same open or closed state, the same trim and depth. If the shelves beside the hidden area are open, the hidden shelves are open too. Never resolve a hidden area by introducing doors, panels, or a design the visible part of that unit does not show at that height.
- INVENT NOTHING ON CLEARED SURFACES: where art, mirrors, or furniture are removed, the wall behind is plain wall — never generate a switch plate, outlet, vent, thermostat, or nail hole that is not in the original. Existing fixtures (smoke detectors, switches, vents) keep their exact model and appearance — do not redraw them as a different device.
- REVEALED SURFACES: where removed objects covered floor or wall, reconstruct the surface EXACTLY as the visible surrounding surface: same flooring material, same plank direction and grain, same carpet pile and colour, same wall paint and baseboard, continuing all existing patterns, seams, and imperfections. Continue any visible wear, scuffs, or marks naturally — do NOT idealize, repaint, refinish, or clean up the property itself. An emptied room must look like the same room, vacant — not a renovated one.
- LIGHTING STAYS AS PHOTOGRAPHED: same exposure, white balance, window views, and every fixture's on/off state.${fixedList}${lightList}
Output the same room, completely empty.`;
}

/** Assemble the prompt for a transformation request (the backend's only entry). */
function buildPrompt(type, options = {}) {
  let p;
  if (type === 'twilight' && options.stage === 'overcast') return overcastPrompt();
  switch (type) {
    case 'declutter': p = declutterPrompt(options.inventory, options.fixedElements); break;
    case 'empty': p = emptyPrompt(options.inventory); break;
    case 'staging': p = stagingPrompt(options.style, options.room, options.layout, options.brief); break;
    case 'twilight': p = twilightPrompt(options.style, options.manifest); break;
    default: throw new Error(`Unknown transformation type: ${type}`);
  }
  // On retry, the orchestrator passes the previous compliance violations so the
  // generator is told exactly what was wrong. Still a closed prompt set: the
  // text comes from our own judge, never from the customer.
  if (options.priorViolations && options.priorViolations.length) {
    p += `\n\nA previous attempt was REJECTED by compliance for the following reasons. Do not repeat them:\n` +
      options.priorViolations.map(v => `- ${v}`).join('\n');
  }
  return p;
}

// Sentence case, not capitals. Kyle, 25 Aug 2026: "nice, light, and airy".
// Shouting the disclosure does not make it more truthful, it just makes the
// photograph worse — and an agent who avoids the feature because of the mark
// discloses nothing at all.
const WATERMARK_TEXT = {
  declutter: 'Virtually decluttered',
  empty: 'Virtually emptied',
  staging: 'Virtually staged',
  // Twilight carried no mark until 5 Sep 2026. Kyle: it "goes against our promise"
  // — every delivered image is disclosed, whatever the transformation.
  twilight: 'Virtual twilight',
};

module.exports = { buildPrompt, STAGING_STYLES, TWILIGHT_MOODS, ROOM_TYPES, WATERMARK_TEXT, PRESERVATION };
