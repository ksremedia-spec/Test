/**
 * Listing Lab — furniture inventory (declutter only).
 * Before generating, a vision call lists every piece of FURNITURE and fixed
 * element in the photo. That list is injected into the declutter prompt as a
 * keep-list and handed to the judge, so "clutter" can never swallow a chair
 * that happens to be buried under laundry.
 */
const { geminiGenerateContent } = require('./gemini');
const { clutterLine, keeperLine } = require('./scope');

async function inventoryRoom(apiKey, imageB64, mime, model) {
  const prompt = `You are cataloguing a real-estate photo before a declutter edit. List every piece of FURNITURE and every FIXED or DECOR element that must survive the edit, even if it is partly buried under clutter. Include: beds, headboards, nightstands, dressers, desks, tables (any size), chairs, stools, benches, shelves/racks, lamps, fans, hung mirrors and wall art, a tall full-length floor mirror made to lean (a wall mirror or framed picture set down on the FLOOR against a wall waiting to be hung is stored — list it as clutter, not keep), rugs, curtains/blinds, window AC units, light fixtures, radiators/baseboards, outlets/switches. Describe each item with material/color and its location in the frame. If an item is cut off by the edge of the photo, say so explicitly ("cut off at left edge — only X visible") so it is not completed or invented. Also note whether each light fixture is ON or OFF.
ALSO KEEP, and never list as clutter (the owner's rulings): ${keeperLine()}. In particular a desktop computer, its monitors, a laptop, a TV or a game console that is set up and in use is part of a working home office or media room — it is a KEEP item; only loose cords, chargers and papers around it are clutter (a delivered office lost its computers on 4 Sep 2026 because they were catalogued as clutter). THE CORD RULE: the single cord running from a kept lamp, TV or appliance to its outlet is part of that item — never list it as clutter (a clean bedroom was charged a declutter on 5 Sep 2026 for its floor lamp's own cord). If the ONLY clutter you can find is that kind of cord, the clutter list is empty.
Do NOT list clutter. Clutter means exactly this, and none of it belongs on a keep list however tidily it is arranged: ${clutterLine()}; plus bedding piles. A trash can is never a fixed or decor element.

SEPARATELY, list the clutter you can actually see, using that same definition. Be literal: name only what is genuinely in the frame. An empty room with nothing on the floor and nothing left out on the surfaces has an EMPTY clutter list, and saying so is the right answer — do not stretch to find something.
Respond with ONLY JSON: {"keep":["item with location", ...], "clutter":["clutter item with location", ...], "lights":[{"fixture":"...","state":"on|off"}]}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: imageB64 } }] }],
    generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
  };
  const json = await geminiGenerateContent(apiKey, model, body);
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  // `clutter: null` when the model did not answer the question at all, which is
  // NOT the same as an empty list. The caller refuses a job on an empty list and
  // must never refuse one on a missing field.
  try {
    const v = JSON.parse(text);
    return { keep: v.keep || [], lights: v.lights || [], clutter: Array.isArray(v.clutter) ? v.clutter : null };
  } catch { return { keep: [], lights: [], clutter: null }; }
}

/**
 * Exterior structure manifest (twilight). A short, concrete description of THIS
 * property's architecture and fixtures, injected into the prompt so "preserve
 * the architecture" names real things — siding, stone, roof, door colour,
 * window count, garage, visible light fixtures.
 */
async function inventoryExterior(apiKey, imageB64, mime, model) {
  const prompt = `Describe this house for a structure-lock instruction, in ONE compact paragraph of plain nouns (no opinions): siding material/colour, stone or brick accents, roof type/colour, number of stories, porch/columns/railings, front door colour, shutters, window count and any grille pattern, garage (attached/detached, door colour), driveway/walkway surfaces, fence, notable landscaping (beds, shrubs, trees), and EVERY visible exterior light fixture (porch lanterns, sconces, post lights, landscape/path lights) with its location. Also say whether landscape lights are visible (yes/no).
Respond with ONLY JSON: {"description":"...", "fixtures":["porch lantern left of front door", ...], "landscapeLights": true|false}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: imageB64 } }] }],
    generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
  };
  const json = await geminiGenerateContent(apiKey, model, body);
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  try { const v = JSON.parse(text); return { description: v.description || '', fixtures: v.fixtures || [], landscapeLights: !!v.landscapeLights }; }
  catch { return { description: '', fixtures: [], landscapeLights: false }; }
}

/**
 * FIXED-ELEMENTS catalogue for the EMPTY transformation. Unlike inventoryRoom
 * (which lists furniture to KEEP for declutter), this lists only what stays when
 * a room is emptied: the property itself plus semi-fixed items. The model
 * classifies directly — never regex-match prose, since an item's LOCATION
 * ("shelf beneath the window") would otherwise misclassify it as fixed.
 */
async function inventoryFixed(apiKey, imageB64, mime, model) {
  const prompt = `You are cataloguing a room photo before every MOVABLE object is digitally removed (a "virtually emptied" listing photo).
List ONLY the elements that must REMAIN because they are part of the property or are semi-fixed:
- curtains, drapes, blinds, shades and their rods/brackets
- wall-MOUNTED televisions and their mounts, wall-mounted shelves that are screwed to the wall
- ceiling lights, ceiling fans, recessed lights, smoke detectors
- built-in shelving, cabinetry, closets, fireplaces and mantels
- radiators, baseboard heaters, window AC units, wall/floor vents, thermostats
- outlets, light switches, door hardware, windows, doors, trim, baseboards
- EVERY MAJOR APPLIANCE: refrigerator, range/stove, cooktop, wall oven, range hood, dishwasher, built-in or over-the-range microwave, washer, dryer, water heater — these sell with the home and ALWAYS stay, whether built in or standing on the floor
DO NOT list anything freestanding or portable — no beds, sofas, chairs, stools, tables, desks, dressers, nightstands, FREESTANDING shelves or racks (even if they sit under a window), rugs, floor or table lamps, box fans, mirrors leaning on a wall, wall art or photos, plants, boxes, or clutter. When unsure whether an item is fixed or freestanding, treat it as freestanding and leave it out.
Describe each kept item with material/colour and location. Also note whether each light fixture is ON or OFF.
Respond with ONLY JSON: {"keep":["item with location", ...], "lights":[{"fixture":"...","state":"on|off"}]}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: imageB64 } }] }],
    generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
  };
  const json = await geminiGenerateContent(apiKey, model, body);
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  try { const v = JSON.parse(text); return { keep: v.keep || [], lights: v.lights || [] }; }
  catch { return { keep: [], lights: [] }; }
}

module.exports = { inventoryRoom, inventoryExterior, inventoryFixed };
