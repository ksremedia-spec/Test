/**
 * Listing Lab — compliance judge.
 * A separate vision-model call inspects ORIGINAL vs CANDIDATE against the
 * rules of the requested transformation and returns a strict JSON verdict.
 * The generator never grades its own work.
 */
const { geminiGenerateContent } = require('./gemini');
const { clutterLine, keeperLine, APPLIANCES_STAY } = require('./scope');
const { checkClaims } = require('./claimcheck');

const RULES = {
  declutter: `The transformation was DECLUTTER: only PERSONAL CLUTTER may be removed — ${clutterLine()}. Everything else stays, including styling the seller put there on purpose: ${keeperLine()}.
VIOLATIONS to check for:
0. CAMERA (always MAJOR — check this first, before anything else): the viewpoint, angle, framing, or perspective differs from the original in any way — the room appears more straight-on or more angled, wider or tighter, a wall enters the frame differently, the horizon or ceiling line sits at a different height. State where one fixed landmark (a window edge, a door frame, a corner of the room) sits in BOTH images before deciding. A shifted camera is not one detail among many; it is a different photograph of the property, and nothing else in the image can make up for it.
1. Any architectural change: walls, windows, doors, trim, built-ins, counters, fixtures, or room proportions differ.
2. Something that CONVEYS with the house was removed or MOVED — the owner's rule, verbatim: "remove or don't, don't just move." SEVERITY IS STRUCTURAL-ONLY (the owner's ruling, 4 Sep 2026: "my system promises no structural changes" — he delivered every frame refused for decor): MAJOR when what went missing or moved is FURNITURE standing on its feet and in use (a bed, sofa, sectional, armchair, dining or kitchen table, desk, dresser, wardrobe, cabinet, bookcase, media console, a shelving unit, a nightstand or side table — the owner failed a delivered bedroom whose nightstand was gone, 28 Aug 2026), a WINDOW TREATMENT (curtains, blinds, rods), a computer, monitor, laptop or TV in use, or anything FITTED to the building — a window air conditioner, baseboard heater, radiator, ceiling fan, wall-mounted unit, mirror or shelf fixed to the wall, outlet, switch or vent. MINOR — record it, never fail on it — when it is loose DECOR or a SMALL PIECE: a lamp, wall art, a picture frame, towels, a bath mat, throw pillows or a throw, bedding restyled, a plant, vase, tray, candle, bowl, basket, clock, a loose area rug, a stool or step stool, a plant stand, a plastic drawer tower or rolling storage cart, or a hook rail, pot rack or small wall rack that held the removed clutter and went with it (the owner delivered a kitchen missing its step stool and a bedroom missing a plastic drawer tower, 4 Sep 2026). BEFORE calling a removed piece a nightstand or side table, say what it is MADE OF: a plastic drawer cart or storage tower — even draped with a cloth and used as a table, even with things stacked on it — is storage, a SMALL PIECE, MINOR; a nightstand is a wooden or metal piece of bedroom furniture. The item should have stayed and the note says so, but a buyer still sees the same room. An object relocated rather than erased carries the same severity as if it had been erased. RESHAPED COUNTS AS MOVED (the owner's grade, 5 Sep 2026: a sectional whose chaise came back detached, floating a hand's width from the sofa, failed — "separated couch"): when clutter was cleared OFF a piece of furniture, the piece underneath must come back as ONE continuous object with the outline the original shows — a sectional stays joined, a sofa keeps its arms and seat count, a table keeps its legs and top, a bed keeps its frame line. A piece split in two, a section pulled away, a missing arm or leg, or a silhouette that no longer matches the parts visible in the original is MAJOR under this check, however clean it looks. Compare the outline of every piece that had clutter on it. THIS RULE IS FOR PIECES WHOSE SHAPE THE ORIGINAL SHOWS — a sofa under a blanket, a table under papers, a bed under laundry. A piece BURIED in a pile, with only a leg, a corner or an edge showing, is part of the mess (the owner passed c028, where a chair swallowed by a clothes pile in the corner went with the pile): if it goes with the pile, that is a SMALL PIECE under check 2 — MINOR — and a piece cut off by the frame edge is check 6's business, which outranks both. EXCEPTION: furniture that was STORED rather than in use — a mattress or box spring on its edge against a wall, a bed frame or table in pieces, a table folded flat, chairs stacked, a headboard leaning behind a door, a wall mirror or framed picture set down on the floor against a wall (hung ones and a full-length floor mirror made to lean stay) — is clutter, and removing it is CORRECT, not a violation. And the reverse is never MAJOR: a mirror or picture left standing on the floor is decor-class — MINOR under 5c if it should have gone (the owner passed a bedroom with its full-length mirror leaning, c001). Fitted wall-to-wall carpet is architecture and its removal or change is MAJOR under check 1/3.
2a. A MAJOR APPLIANCE REMOVED, REPLACED OR RELOCATED (always MAJOR): ${APPLIANCES_STAY} sell with the home in every case. If one is gone, swapped for a different model, moved, or turned into countertop/cabinet, fail — whatever else went right. Their clutter (magnets, papers, items on top) is a different matter and should be gone.
2b. NOT a violation: a FREE-STANDING appliance the seller takes with them is clutter and SHOULD be gone — a box fan or floor fan, space heater, dehumidifier, humidifier, air purifier, vacuum cleaner, portable AC, drying rack or fold-up hamper. Do not fail an image for removing one. The distinction from check 2 is fitted versus free-standing, not what the object does.
2c. NOT a violation: children's toys, stuffed animals, and baby/child gear — a playpen or pack-n-play, changing table, high chair, stroller, swing or bouncer, diaper caddy, hanging organizer — are the family's belongings, leave with them, and SHOULD be gone, even standing in use and even arranged neatly on a shelf or bed. Do not fail an image for removing them. Shelves and furniture they sat on or in must themselves remain.
3. Flooring, paint, or material finishes changed.
4. Something was ADDED to the room — SEVERITY IS STRUCTURAL-ONLY here too (the owner's ruling, 4 Sep 2026: he delivered a bedroom refused for an invented table lamp, and another refused for an added side table and restyled pillows): MAJOR when the addition is a LARGE piece of furniture (a bed, sofa, sectional, dining table, dresser, wardrobe, cabinet, desk), anything fixed or built in (a fixture, a window, a door, a fireplace, shelving on the wall), or an appliance. MINOR — record it, never fail on it — when it is small decor or a small piece: a lamp, pillows, a throw, bedding restyled, a plant, vase, art, a basket, a side table or nightstand. Note it in "violations" as minor and move on.
5. Revealed surfaces were reconstructed incorrectly (wrong flooring/counter/wall where an object was removed).
5b. HALF-ERASED OBJECTS AND GHOSTS (always MAJOR — and checked BY PROCEDURE, not by impression): first LIST the objects that are present in the original and gone from the candidate — name at least the large ones and where each stood. Then, for EACH removal site, look at that exact spot in the candidate and say what is there now: a clean plausible surface, or residue — smears, faint outlines, wavy or squiggly remnants, discoloured patches, a blurred region, phantom shadows with no object to cast them. A cord half-erased into grey squiggles is the canonical case. Every object must be in exactly one of two states: fully present, crisp and untouched; or fully gone with a clean surface behind it. Anything in between is MAJOR: a smear, an outline, a half-erased object, a mottled or smudged surface where things were cleared, a floating fragment, a warped door or cabinet edge. An image delivered on 2 Sep 2026 carried ghosting the owner called "insane" — a mottled table top, a floating plug, a fragment by a desk leg — missed by judges who admired the overall room instead of inspecting the removal sites one by one. (A faint softness only a magnified crop could reveal is judged by the close-up review, not here; at whole-frame scale, if you can see it, it is MAJOR.) REFLECTIONS ARE NOT JUDGED (the owner's standing rule: "AI can't get reflections right"): what a mirror, glass door, TV screen or glossy surface shows — removed items still reflected, a reflection that changed, a reflection that no longer matches the room — is never a ghost and never a violation of any check; the mirror itself must remain, its contents are ignored.
5c. PERSONAL CLUTTER LEFT BEHIND (sweep BY PROCEDURE, not by impression: scan the candidate's floor edge-to-edge including corners and along furniture legs, then every seat and surface — bed, sofa, desk, dresser, table tops, windowsills — and say what you find on each before deciding; a delivered image on 2 Sep 2026 kept clutter sitting on the floor by a table that judges never looked under): an item from the clutter list above is still visible in the candidate. NOT A LEFTOVER: anything mounted on the wall as decor — a plaque, sign, name letters, framed art, a mirror, a shelf — is wall art under check 2 and was RIGHT to stay, whatever it says on it (the owner passed a child's bedroom with the name plaques on the wall four times over, 4 Sep 2026); only the clutter categories above count here. SEVERITY BY SIZE, measured not felt: leftover clutter items that together cover only a tiny fraction of the frame (roughly 1.5% or less — a soap bottle, one small cup) are MINOR — record them, never fail on them; a decluttered room with one small item left is a sellable photograph. A prominent leftover (a full laundry pile, a stroller, packed shelves) is MAJOR. PROMINENCE IS POSITION AS WELL AS SIZE: a trash can filling the foreground of a small room is MAJOR (the canonical bathroom-bin miss), but the same can partly hidden behind cabinetry in the background of a wide shot is judged by its measured size like anything else — the owner passed exactly that frame (2 Sep 2026). NEVER TINY, WHATEVER THEIR PIXEL SHARE (the owner's grades, 4 Sep 2026: a broom left standing in a corner and a pile of cords at the frame edge each failed a delivered photograph): brooms, mops, ladders, drying racks, laundry baskets and hampers, bags, boxes, and a TANGLE, BUNDLE OR PILE of loose cords or cables lying on the floor are MAJOR when left, however small they measure — a buyer's eye goes straight to them. (A single cord running from a kept lamp, TV or appliance to its outlet is part of that item, never a leftover — the cord rule.) EXCEPTION, whatever its size: a portable ROOM appliance left behind — a box fan, floor fan, space heater, dehumidifier, humidifier, air purifier, or a vacuum cleaner (upright, handheld or robot), on the floor or on a side table (the owner passed a bedroom with its box fan still on the pedestal table, 2 Sep 2026: it reads as an appliance, not as mess) — is MINOR; and so is a small KITCHEN appliance (a countertop microwave, toaster, coffee maker, air fryer, blender, grill) left on a counter or worktop where it lives. It should have gone, so note it, but a photograph is never rejected over one. THE EXCEPTION ENDS WHERE A KITCHEN APPLIANCE IS OUT OF PLACE (the owner's grade, 5 Sep 2026: a countertop grill left sitting on a dining chair in the foreground failed the photograph — "not something I would classify as small"): a cooking appliance parked on a chair, sofa, bed, or the floor is mess, judged by size and prominence like any other leftover — MAJOR when it is prominent. AND THE CHECK FOLLOWS THE SEVERITY: when the only clutter left is minor under this rule — tiny items within the size allowance, or a portable appliance — the personal_clutter_all_gone check still answers ok:true, with the leftover named in its evidence. Answering that check false IS failing the photograph, so it is false only for a MAJOR leftover.
6. (MINOR — RECORD IT, NEVER FAIL ON IT, and this outranks checks 2 and 4 above) THE FRAME EDGE IS OUT OF SCOPE, IN BOTH DIRECTIONS. An object more than roughly half outside the frame — a chair cut off at the corner, the end of a table, a fragment of something in the foreground — may be completed, redrawn, OR removed entirely, and none of those is a violation. It is a fragment either way and it is not how the room reads to a buyer; a rolling chair half out of shot with laundry piled on it is part of the mess, not part of the staging. If your only complaints about an image concern objects at the frame edge, the image PASSES.
7. The room's overall exposure/brightness or white balance changed: MAJOR. A single fixture's on/off state flipping while the room's exposure stays as photographed is MINOR — record it, do not fail on it (the owner's grade, 2 Sep 2026: a delivered declutter's ceiling dome came on, the room read identically, he passed it).`,
  empty: `The transformation was EMPTY ROOM: every movable object (furniture, rugs, lamps, art, plants, decor, clutter) is removed so the room is completely vacant. Curtains/blinds, wall-mounted TVs, ceiling fixtures, built-ins, radiators/heaters, window AC units, outlets/switches/vents stay.
VIOLATIONS to check for:
0. CAMERA (always MAJOR — check this first, before anything else): the viewpoint, angle, framing, or perspective differs from the original in any way. State where one fixed landmark (a window edge, a door frame, a corner of the room) sits in BOTH images before deciding. A shifted camera is a different photograph of the property.
1. Any architectural change: walls, windows, doors, trim, built-ins, cabinetry, counters, fixtures, or room proportions differ.
2. A movable object remains (furniture, rug, art, plant, lamp, box, clutter) — the room must be COMPLETELY vacant of movables.
3. A KEEP item was removed: curtains/blinds/rods, wall-mounted TV, ceiling fixture/fan, built-in, radiator/baseboard/window AC, outlet/switch/vent/thermostat/smoke detector.
3b. A MAJOR APPLIANCE REMOVED, REPLACED OR RELOCATED (always MAJOR, checked BY PROCEDURE in any kitchen, laundry or utility space): list the appliances in the original — ${APPLIANCES_STAY} — and find EACH one in the candidate at the same spot, same model. An emptied kitchen keeps its range, refrigerator, dishwasher and hood; an emptied laundry keeps its washer and dryer. One missing, or turned into countertop or cabinet, fails the image whatever else went right (the owner's rule, 3 Sep 2026: "removing the range is never acceptable, even in an empty room").
4. REVEALED-SURFACE MISMATCH: floor or wall where objects were removed does not match the visible surrounding surface — different plank direction, grain, carpet texture/colour, paint tone, or missing baseboard. Compare revealed regions to ADJACENT VISIBLE surfaces only. THE OCCLUSION RULE APPLIES: a region hidden in the original could have held anything — any plausible continuation of the surrounding surface is CORRECT, and it is NOT a violation that a revealed patch looks cleaner than you guessed it would (walls behind furniture genuinely are less worn). Judge the match to the surroundings, never the match to your own guess about what was hidden.
5. CONCEALMENT/IDEALIZATION: a SPECIFIC blemish, stain, patch, crack, or material texture visible in the original is gone — name it and where it was. A clean, evenly painted wall is NOT idealization by itself: most walls ARE uniform, and the pipeline measures global tone and colour with instruments. "The walls look more uniform/pristine/refined overall" is never a violation on its own.
6. Any light fixture changed on/off state; or an unmistakable, dramatic exposure or white-balance change (day turned to dusk, a colour cast). Subtle global brightness differences are measured by the pipeline's colour lock with real numbers — do not report them from eyesight alone.
7. HALF-ERASED OBJECTS AND GHOSTS (always MAJOR): a removed object left smears, faint outlines, wavy remnants, or a blurred patch where it stood. Every object is either fully present and crisp, or fully gone with a clean plausible surface behind it — nothing in between.`,
  staging: `The transformation was VIRTUAL STAGING: freestanding furniture, rugs, art, plants, and decor may be ADDED to an empty or sparse room. The customer requested the room be staged as: {{ROOM_TYPE}}.
0. WRONG ROOM TYPE (major): the furniture does not stage the room as a {{ROOM_TYPE}} — e.g. a bed in a room requested as a living room, a sofa grouping in a room requested as a bedroom, a dining set in an office. The anchor piece for the requested room type must be present and the room must read unmistakably as that room.
VIOLATIONS to check for:
0b. CAMERA (always MAJOR — check this before anything else): the viewpoint, angle, framing, or perspective differs from the original in any way. State where one fixed landmark (a window edge, a door frame, a corner of the room) sits in BOTH images before deciding. A shifted camera is a different photograph of the property, and no amount of good staging makes up for it.
1. Any architectural change: walls, windows, doors, trim, built-ins, cabinetry, counters, fixtures, flooring, or room dimensions differ; or a major appliance (${APPLIANCES_STAY}) is removed, replaced or moved.
2. Added furniture covers or overlaps a window, door, doorway, light switch, thermostat, built-in, or fireplace; OR standing furniture blocks a door from opening or a doorway from being walked through. (NOT violations: wall outlets behind furniture; a sofa/headboard standing IN FRONT of a window whose back rises past the sill — that is how real rooms with window walls are furnished; only flag a window if something mounted ON the wall covers its glass or furniture blocks most of the glass. A rug edge or a chair near an opening that still leaves a walking path is MINOR.) (FLOOR VENTS AND OUTLETS: added furniture and rugs routinely stand on or in front of them — a vent or outlet no longer visible under a sofa, rug, or table is NEVER a violation. Kyle's reference staging, graded "perfect", covers one.) (the floor area in front of a door, roughly one door-width deep, must be empty so the door can open and be walked through). (Furniture standing in FRONT of a baseboard heater or radiator with a visible gap is normal and is NOT a violation; only flag it if the heater is fully hidden or the furniture is pushed flush against it.)
3. Wall color, flooring, or any fixed finish changed.
4. REALISM TELLS (each is a violation on its own):
   4a. SCALE — use fixed elements as rulers (a door ≈ 36in/91cm wide, outlets ≈ 12in above floor, window sills): a bed, sofa, or table clearly too small or too large for the room; undersized furniture that makes the room look bigger misrepresents the listing.
   4b. SHADOWS — identify the dominant light source (windows) in the ORIGINAL; every added piece must cast a contact shadow where it meets the floor, and shadow direction/softness must agree with that light and with shadows already in the photo. No shadow, a blurry gray blob, or shadows pointing toward the window are violations.
   4c. PASTED-CUTOUT LOOK — furniture lit from a different direction than the room, carrying its own embedded lighting, or brighter than the scene's light could make it.
   4d. PERSPECTIVE — furniture rendered at a different focal length or with vanishing points that disagree with the room's.
5. Anything that existed in the original was removed. Before finishing this check, SWEEP the original for fixtures and fittings — a window AC unit, wall-mounted shelves, radiators, curtains and blinds, mounted fixtures — and confirm each one is still present and unchanged in the candidate. Any of them missing is MAJOR, however much cleaner the staging looks without it. Floor vents and wall outlets are NOT part of this sweep — added furniture and rugs legitimately cover them.
6. STAGER'S REVIEW (MINOR only — record, never fail on these; measured 2 Sep 2026: judges answer the which-way-does-the-sofa-face question like a coin flip, killing graded passes while missing graded fails, so orientation is enforced where it is controllable — in the generation brief — not here): the main seating does not face the room's obvious focal point; a sofa runs sideways or back-to-it; chairs face empty floor rather than forming a conversation group; the rug does not sit under the grouping; pieces slightly out of scale; the grouping pushed into one corner of a large room with the rest empty.`,
  twilight: `The transformation was TWILIGHT: the daytime sky was replaced with a post-sunset sky and the whole scene relit for that time of day. Exposure, color, and mood are the editor's choice and are NOT violations — only changes to the property are. Windows are expected to be lit with a warm translucent glow; existing porch/landscape fixtures are expected to be on.
VIOLATIONS to check for:
1. Any change to the structure: roofline, siding, stone, windows or their grille patterns, doors, porch, columns, railings, driveway, walkways, or proportions differ.
2. Landscaping materially changed: trees/shrubs/beds added, removed, or reshaped.
2b. SKY-EDGE FOLIAGE (MINOR in BOTH directions at the frame edge): compare the TOP edge and corners of both frames. MAJOR only if a whole overhanging canopy or branch mass that framed the house is gone, or a tree has clearly grown taller/denser IN THE BODY of the frame. Thinning, softening, a few lost leaves — or a few INTRODUCED leaves or branch tips hanging into the top edge (the owner's grade, 2 Sep 2026: passed) — is MINOR: record it, never fail on it. Describe the top-left, top-center, and top-right of each image before deciding.
2c. REAL STRUCTURES ERASED BY SKY (always MAJOR): any real building present in the original — a neighboring house, a distant rooftop, a garage, shed, or any structure, especially along the TOP edge or filling the upper part of an AERIAL frame — must still be present in the candidate. The new sky is allowed ONLY where the original was already open sky. If a region that held real houses or rooftops in the original is now painted sky, that is real property erased to prettify the frame — fail it. Describe what occupies the top edge (and, in an aerial, the upper third) of BOTH images before deciding: real structures in the original that became sky in the candidate is the violation.
2d. SKY INVENTED WHERE NONE EXISTED (always MAJOR — the dangerous input is a photo with LITTLE OR NO open sky): before judging, state roughly what fraction of EACH frame is open sky. The candidate may recolor the sky the original has; it may not have MORE of it. If the candidate shows meaningfully more open sky than the original — a tree canopy thinned or removed, buildings receded, the top band of a dense frame opened up to fit a sunset — then something real was erased to manufacture that view: MAJOR. An original with almost no sky must produce a twilight with almost no sky.
3. LIGHT INVENTED (the owner's rule, 2 Sep 2026: only what exists may glow): a window or door was ADDED that does not exist in the original, or ANY light source appears that the original photo does not contain — a post lamp, path or landscape lights, string lights, spotlights, sconces, uplighting on trees or siding. Turning ON a fixture that is visibly present in the original (a porch light, an existing sconce, an existing landscape fixture) is expected and correct; CREATING one, however small, is MAJOR. Check this BY COUNT, not by impression: count the light fixtures ON THE HOUSE in the ORIGINAL (beside the door, on the garage, on posts) and count them in the CANDIDATE, and state both numbers. More fixtures than the original, fixtures that multiplied (two door lanterns becoming four), grew, or moved along the wall: MAJOR (a delivered failure on 2 Sep 2026 doubled the door lanterns and judges read them as "the sconces, lit"). GROUND-LEVEL glows are the opposite presumption: landscape stakes at bed edges are nearly invisible in daylight, so a glow low in a planting bed or garden counts as an existing fixture being lit UNLESS the exact spot in the original is clearly bare lawn, pavement or mulch with nothing standing in it. For every other glowing point outside a window, say which original fixture produces it — and LOOK PROPERLY before answering: landscape light fixtures are small and nearly invisible in daylight (a dark stake or short post at a bed edge, a well light in mulch, an unlit lantern against stone). Examine the exact spot in the ORIGINAL where each glow sits; a glow at a bed line where a stake or post is visible in the daytime photo is an existing fixture being lit, which is correct (2 Sep 2026: two of the owner's passes were nearly failed as "invented uplighting" — the stakes were in the original all along, only small). Call a glow invented only when the original spot shows NOTHING that could produce it.
4. DAYLIGHT RESIDUE — read the two halves separately, they are not the same fault:
   4a. (MAJOR only when it READS AS SUNLIGHT) hard-edged cast shadows that contradict the time of day: the house, a tree trunk or the eaves throwing a strong directional shadow across the lawn or facade the way afternoon sun does. Branch dapple or a traceable shadow patch on the driveway alone, in a scene that otherwise reads fully as dusk, is MINOR — record it, never fail on it (the owner's grade, 2 Sep 2026: passed exactly this). Ask "does this image claim the sun is up?" — only a yes is MAJOR.
   4b. (MINOR — record it, do not fail on it) SOFT residual shading: gentle tonal variation across the grass, a diffuse light patch, dappled softness with no defined edge. Kyle graded exactly this a PASS on his own golden set — "soft residual lawn shading from daytime shadows is acceptable for what we're doing". Real twilight lawns are not evenly lit either. If your only complaint about an image is soft lawn shading, the image PASSES.
5. STYLE (minor only — never fail on these): windows rendered as an opaque yellow fill with no glass detail; facade or lawn so dark that detail is lost; a heavy single-color cast. Record as minor.
6. The result reads as fake: halos along the roofline or trees, painted-on sky edges, mismatched light direction.
7. CAMERA (always MAJOR — check first, and answer the questions below IN WRITING before any verdict): a twilight is the SAME PHOTOGRAPH relit — never a new photograph of the same property. Before deciding, state for BOTH images: (a) where the roof peak sits in the frame (left/center/right third, and roughly how far down from the top edge); (b) where the house's left and right edges fall (which thirds); (c) roughly what fraction of the frame the house fills; (d) where the driveway or walkway enters the bottom edge. If ANY of these answers differs between the two images — the house fills more of the frame, sits shifted, the drive enters elsewhere — the camera moved: MAJOR, whatever else is right about the image. Delivered failures on 2 Sep 2026 were exactly this: same house, larger and shifted, windows redrawn — passed by judges who checked "the angle" in the abstract instead of stating these positions.`,
};

/** Named checks the judge must answer one by one (prevents skimming). */
const CHECKS = {
  // `camera_angle_and_framing_identical` leads every list, not only twilight's.
  // It was folded inside `architecture_unchanged` on the interiors, competing for
  // attention with walls, trim, counters and built-ins — and a shifted camera is
  // not one detail among several, it is a different photograph of the property.
  // Kyle, 27 Aug 2026: "Camera shift should absolutely be an auto fail."
  empty: ['camera_angle_and_framing_identical', 'architecture_unchanged', 'room_completely_vacant_of_movables', 'fixed_elements_all_present', 'revealed_surfaces_match_surroundings', 'no_ghosts_or_half_erased_objects', 'no_idealization_or_concealment', 'lighting_state_and_exposure_unchanged'],
  // `personal_clutter_all_gone` and `no_ghosts_or_half_erased_objects` joined
  // in the teardown (2 Sep 2026): the separate clutter-left verifier and the
  // never-wired artifact critic are gone, so the one judge asks their
  // questions itself. The clutter check carries the tiny-leftover severity
  // rule from 5c; the ghost check carries 5b.
  declutter: ['camera_angle_and_framing_identical', 'architecture_unchanged', 'all_furniture_and_decor_present_and_unmoved', 'nothing_added', 'finishes_unchanged', 'revealed_surfaces_plausible', 'no_ghosts_or_half_erased_objects', 'personal_clutter_all_gone', 'lighting_state_and_exposure_unchanged', 'keep_list_all_present'],
  // No orientation check name here, deliberately (2 Sep 2026): both the
  // separate focal gate and a judge-side flagrant-orientation check answered
  // the which-way-does-it-face question like a coin flip on Kyle's graded
  // set. Orientation lives in the generation brief now — construction, not
  // inspection; rule 6 records it as minor.
  staging: ['camera_angle_and_framing_identical', 'staged_as_requested_room_type', 'architecture_unchanged', 'keep_clear_boxes_empty', 'no_window_door_switch_covered', 'finishes_and_window_treatments_unchanged', 'furniture_scale_plausible_vs_door_and_outlets', 'contact_shadows_present_and_match_light_direction', 'nothing_original_removed', 'decor_anonymous'],
  // The check NAMES are instructions too — a model handed "no_daylight_residue_on_lawn"
  // fails any shading at all, however soft, because the name says none. Kyle grades
  // soft residual shading a PASS, so the name has to carry the same standard as
  // rule 4 does. `framing_unchanged` was also a second name for
  // `camera_angle_and_framing_identical`: one fault, two complaints, no extra safety.
  twilight: ['camera_angle_and_framing_identical', 'structure_unchanged', 'landscaping_unchanged', 'sky_edge_foliage_unchanged', 'no_real_structures_replaced_by_sky', 'exterior_fixture_count_matches_original', 'no_hard_edged_sun_shadows_on_lawn', 'no_hard_edged_sun_shadows_on_house_and_foundation', 'no_halos_or_artifacts'],
};

const UNIVERSAL = `UNIVERSAL VIOLATIONS (any transformation):
- People, animals, readable text, logos, or brand marks were introduced. EXCEPTION — OUR OWN STAMP: a small white corner caption reading "Virtually staged", "Virtually decluttered", "Virtually emptied" or similar is this system's disclosure watermark, applied on delivery. It is NEVER a violation and never worth mentioning; judge the photograph beneath it.
- The image was cropped, extended, rotated, or the aspect changed.
- Obvious generation artifacts: warped lines, melted textures, duplicated features, or GHOSTS — smears, faint outlines, or wavy remnants where an object was partially erased.`;

/**
 * Judge a candidate image. Returns {pass, confidence, violations[], notes}.
 * @param apiKey Gemini API key
 * @param type declutter|staging|twilight
 * @param originalB64/candidateB64 base64 JPEG/PNG data
 */
async function judgeCompliance(apiKey, type, originalB64, originalMime, candidateB64, candidateMime, judgeModel, inventory) {
  const layoutBlock = inventory && inventory.doors && inventory.doors.length
    ? `\nLAYOUT PLAN measured from the original (percent of frame, y from top). Each KEEP CLEAR box marks a door swing or threshold. For EACH box, name what stands inside it in the candidate before judging. Then apply the FUNCTIONAL test, not the geometric one, and it differs by what the box protects.
A SWINGING DOOR's box: MAJOR only when furniture stands DIRECTLY IN FRONT of the door leaf, inside the space the leaf sweeps through as it opens — the door would strike it before a person could enter. Furniture beside the door against the wall, behind the hinge side, or at the box's edge outside the sweep is MINOR, however much of the box's area it overlaps.
An OPENING with no leaf (a stairwell, archway, cased opening, doorless passage): nothing swings, so MAJOR only when a LARGE piece — a sofa, sectional, bed, dining table, media console — stands inside the passage itself, where a person would walk.
EVERYWHERE: a side table, floor lamp, potted plant, armchair, or rug inside or at the edge of a box is MINOR on its own, always. Overlap percentages prove nothing by themselves; name the door leaf or the passage and state what would physically be in its way:\n${inventory.doors.map(d => { const z = d.clear_zone || {}; return `- ${d.name}: clear box x ${z.x_from}%–${z.x_to}%, y ${z.y_from}%–${z.y_to}%`; }).join('\n')}\n` : '';
  const keepBlock = inventory && inventory.keep && inventory.keep.length
    ? `\nKEEP LIST catalogued from the original before editing — confirm EACH is still present, in place, and unchanged in the candidate; any missing or moved item is a violation, EXCEPT an item at the frame edge: the frame-edge rule outranks this list, so a listed item more than half outside the frame may be completed or removed without violation${type === 'declutter' ? '. SEVERITY follows rule 2: a missing piece of FURNITURE in use, window treatment, computer/TV in use, or fitted item is MAJOR; missing loose DECOR (lamp, art, pillows, throw, plant, vase, towel, basket, rug) is MINOR — record it, never fail on it' : ''}:\n${inventory.keep.map(k => '- ' + k).join('\n')}\n` : '';
  /**
   * THE CLUTTER CHECKLIST (the owner's grades, 4 Sep 2026). "Sweep the floor
   * edge to edge" still walked past a broom in a corner and a pile of cords at
   * the frame edge. The catalogue taken before generation had named both.
   * So the judge no longer sweeps by impression: it is handed that list and
   * must answer for every item — gone, still there, or partly — before it
   * may pass the photograph. The code below then holds it to its answers.
   */
  const clutterBlock = type === 'declutter' && inventory && Array.isArray(inventory.clutter) && inventory.clutter.length
    ? `\nCLUTTER CHECKLIST catalogued from the original before editing. For EACH item, find its spot in the candidate and answer in the "checklist" field: "gone" (fully removed, clean surface behind it), "still" (essentially unremoved), or "partly" (some of it or a remnant remains — then name in "left" exactly what remains, e.g. "one small jar on the bottom shelf"). Do not skim: an item you have not looked for is not "gone". Every "still" or "partly" item is a leftover under check 5c — record it as a violation with the severity 5c prescribes (the never-tiny categories are MAJOR; a tiny item within the size allowance or a portable appliance is MINOR):\n${inventory.clutter.map(c => '- ' + c).join('\n')}\n`
    : '';
  const prompt = `You are the compliance auditor for a real-estate photo AI system. Image 1 is the ORIGINAL photograph. Image 2 is the AI-EDITED CANDIDATE.

${(RULES[type] || '').replace(/\{\{ROOM_TYPE\}\}/g, (inventory && inventory.roomType) || 'the requested room type')}
${keepBlock}${clutterBlock}${layoutBlock}
${UNIVERSAL}

Compare the two images carefully, region by region. Real-estate marketing rules require the property itself to remain truthful.

Grade each violation by SEVERITY:
- "major": anything that misrepresents the property or its contents — an object added, removed, moved, or changed in kind; any architectural, finish, window-treatment, or camera change; a light switched on/off or exposure changed; people, text, or logos; a partial object completed into a full one.
- "minor": small, plausible reconstruction differences in a region that was hidden under removed clutter (slightly different shading, a leg or edge drawn a little differently, texture detail), or rendering softness that does not change what the object IS.
${type === 'declutter' ? `FOR DECLUTTER THE LINE IS STRUCTURAL (the owner's ruling, 4 Sep 2026, and it overrides the "major" definition above where they differ): MAJOR is walls, windows, doors, built-ins, cabinets, counters, floors, finishes, fixtures, appliances, window treatments, the camera, furniture in use gone or moved, a large piece added, a ghost a buyer would notice, or clutter clearly left. Everything else — a small decor item added, removed, moved or restyled, a stool or drawer tower gone, bedding restyled, a mark only a magnified crop reveals — is MINOR: recorded in "violations" with severity "minor", and the photograph ships.
` : ''}
THE OCCLUSION RULE (31 Aug 2026 — an agent cannot reshoot the photo they are uploading): a region of wall, shelving, or built-in that is HIDDEN in the ORIGINAL behind an object the edit legitimately removed (a lamp, a plant, furniture, a stack of belongings) has nothing in the original to compare against — no one, including you, can know what was behind it. A reconstruction in such a region is MINOR (acceptable) when it is CONSISTENT with the visible geometry of that same wall or unit: a continuation of its shelving, doors, panelling, or plain wall in the style the visible portions of that unit actually show. Before calling a difference in any region a violation, first check whether that region was visible in the original at all; if it was hidden, apply this rule. It is still MAJOR if the fill invents something the visible parts of that unit or wall nowhere show — a new window, door opening, fixture, or fireplace, wrong proportions, or a design foreign to the unit.
The candidate PASSES when there are no major violations. Minor violations are recorded but do not fail it.

Work through EVERY check below, one at a time, and write one sentence of evidence for each — what you actually see in each image for that check. Do not skip any. A check answers ok:false ONLY for a MAJOR finding; a finding the rules call MINOR (loose decor gone or moved, a lamp or pillows added, a loose rug gone, a portable appliance left, a tiny leftover, a frame-edge fragment, a mark only a crop reveals) is written into "violations" with severity "minor" and the check stays ok:true — answering false IS failing the photograph. In particular all_furniture_and_decor_present_and_unmoved is false only for missing or moved FURNITURE (a nightstand counts), window treatments, in-use electronics or fitted items — never for decor, a stool, a plant stand or a plastic drawer tower, and nothing_added is false only for an added large piece, fixture, or appliance. For the sun-shadow checks, describe the lawn's shading pattern and the foundation wall in the CANDIDATE specifically, and say whether the shading has a DEFINED EDGE you could trace or is soft and diffuse — that distinction is the whole check.
A check whose only complaint is something a rule above marks MINOR is a PASS for that check. Record the observation under minor, not under violations.

For the architecture_unchanged and fixed_elements checks: when you find a difference in a region, FIRST write whether that region is fully VISIBLE in the ORIGINAL, or hidden there behind an object the edit removed (a lampshade, plant, furniture, belongings). If it is hidden, THE OCCLUSION RULE above governs: you do not know what was behind the object, and neither does anyone else — do NOT reconstruct the hidden region in your head from what is above or below it and then fail the candidate against your own guess. Judge only whether the fill is consistent with that unit's visible design anywhere on the unit; if it is, record it as minor with the word "occluded" in the evidence. Fail the region only for a fill the visible unit nowhere supports.

For the arrangement check (staging): first state WHERE the focal point is in the frame (e.g. "fireplace, back wall, x≈62%"); then state where the sofa is and which way its BACK faces (toward which wall); then where each chair faces. Seating "faces the focal point" only if a person sitting on it would be looking at the focal point. A sofa whose back is to a side wall and whose seat faces across the room — not toward the focal point — FAILS this check even if it is near the focal point.

CHECKS: ${CHECKS[type].join(', ')}

Every violation that says a SPECIFIC OBJECT was removed, missing, replaced, moved or altered MUST carry "box_2d" — the object's location in the ORIGINAL, [ymin, xmin, ymax, xmax] normalized 0-1000. Such claims are verified against the pixels at that spot; a claim without a box cannot be verified and a claim that the pixels contradict is discarded.

Respond with ONLY this JSON, no markdown:
{"checks": {${CHECKS[type].map(c => `"${c}": {"ok": true|false, "evidence": "..."}`).join(', ')}},${clutterBlock ? '\n "checklist": [{"item": "the catalogued item, verbatim", "status": "gone|still|partly", "where": "one phrase", "left": "for partly: what exactly remains"}, ...],' : ''}
 "pass": true|false, "confidence": 0.0-1.0,
 "violations": [{"severity": "major|minor", "text": "specific violation with location in image", "box_2d": [ymin, xmin, ymax, xmax]}, ...],
 "notes": "one-sentence overall assessment"}`;

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: originalMime, data: originalB64 } },
        { inline_data: { mime_type: candidateMime, data: candidateB64 } },
      ],
    }],
    generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
  };

  const json = await geminiGenerateContent(apiKey, judgeModel, body);
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  try {
    // Fences and stray prose around the JSON are stripped before parsing — an
    // unreadable verdict is a refused photograph, so the parser earns its keep.
    const verdict = JSON.parse(text.replace(/^[\s\S]*?(\{)/, '$1').replace(/\}[^}]*$/, '}'));
    if (typeof verdict.pass !== 'boolean') throw new Error('missing pass');
    const raw = verdict.violations || [];
    // Normalise to {severity, text}; plain strings (older judge output) count as major.
    verdict.violationDetails = raw.map(v => typeof v === 'string' ? { severity: 'major', text: v } : { severity: v.severity === 'minor' ? 'minor' : 'major', text: v.text || '', ...(Array.isArray(v.box_2d) ? { box_2d: v.box_2d } : {}) });
    verdict.checks = verdict.checks || {};
    for (const [name, c] of Object.entries(verdict.checks)) {
      if (c && c.ok === false && !verdict.violationDetails.some(v => v.severity === 'major' && v.text.toLowerCase().includes(name.split('_')[1] || '\u0000'))) {
        verdict.violationDetails.push({ severity: 'major', text: `[${name}] ${c.evidence || 'check failed'}` });
      }
    }
    // The checklist is binding: a "still"/"partly" answer with no violation
    // written for it becomes one here — MAJOR for the never-tiny categories
    // (5c), MINOR otherwise — so a leftover the judge admitted to cannot be
    // waved through in the same breath.
    if (Array.isArray(verdict.checklist)) {
      // Cords: a TANGLE, bundle or pile is never tiny (the owner's 4 Sep grade);
      // "loose cords" running to an outlet behind a kept fan are the cord rule's
      // business and fall to the size allowance (he passed c001 with them).
      const NEVER_TINY = /broom|mop|ladder|drying rack|tangle|bundle|pile|heap|laundry basket|hamper|\bbags?\b|\bboxes?\b|tangled (cords|cables|wires)/i;
      const PORTABLE = /fan\b|space heater|dehumidifier|humidifier|air purifier|vacuum|microwave|toaster|coffee maker|air fryer|blender|kettle/i;
      for (const c of verdict.checklist) {
        if (!c || !/^(still|partly)$/i.test(String(c.status || ''))) continue;
        const item = String(c.item || '').trim(); if (!item) continue;
        const key = item.toLowerCase().split(/[,:(]/)[0].trim().slice(0, 40);
        const mentioned = verdict.violationDetails.some(v => v.text.toLowerCase().includes(key.slice(0, Math.max(12, Math.min(key.length, 24)))));
        if (mentioned) continue;
        // Severity is judged on what is LEFT, not on the catalogue line: a
        // "partly" answer for "food boxes, jars and packages on the shelf"
        // whose remnant is one small jar is MINOR — the word "boxes" in the
        // catalogue does not make a jar a box (e02, 5 Sep 2026: a clean
        // render was rejected exactly so). With no "left" text, a partly
        // remnant of a never-tiny line is still MAJOR — the judge did not say.
        const left = /^partly$/i.test(String(c.status)) ? String(c.left || '').trim() : '';
        const subject = left || item;
        // A portable appliance is only minor where it belongs; one parked on
        // a chair, sofa, bed, table or the floor is judged by its size.
        const KITCHEN_APPLIANCE = /microwave|toaster|coffee maker|air fryer|blender|kettle|grill|hot plate|slow cooker|instant pot|rice cooker/i;
        const OUT_OF_PLACE = /\bon (a |the )?(dining |office |desk |arm)?(chair|seat|sofa|couch|bed|mattress|floor)\b/i;
        const severity = PORTABLE.test(subject) || KITCHEN_APPLIANCE.test(subject)
          ? ((KITCHEN_APPLIANCE.test(subject) && OUT_OF_PLACE.test(subject + ' ' + (c.where || ''))) ? 'major' : 'minor')
          : NEVER_TINY.test(subject) ? 'major' : 'minor';
        verdict.violationDetails.push({ severity, text: `[checklist] ${c.status}: ${item}${left ? ' (left: ' + left + ')' : ''}${c.where ? ' — ' + c.where : ''}` });
      }
    }
    verdict.violations = verdict.violationDetails.filter(v => v.severity === 'major').map(v => v.text);
    verdict.minor = verdict.violationDetails.filter(v => v.severity === 'minor').map(v => v.text);
    // pass is decided by OUR rule, not the model's self-reported flag
    verdict.pass = verdict.violations.length === 0;
    // THE CLAIM CHECK (4 Sep 2026): a failing vote's object-removal claims
    // are held to the pixels, then to the crops — see claimcheck.js.
    if (!verdict.pass && process.env.CLAIM_CHECK !== '0') {
      try {
        await checkClaims(apiKey, judgeModel, Buffer.from(originalB64, 'base64'), Buffer.from(candidateB64, 'base64'), verdict);
      } catch (e) { verdict.claimCheckError = String(e.message || e).slice(0, 120); }
    }
    return verdict;
  } catch (e) {
    // An unparseable verdict is a failed check — never deliver on ambiguity.
    if (process.env.JUDGE_DEBUG) { require('fs').writeFileSync('/tmp/soak/unreadable-' + Date.now() + '.txt', JSON.stringify({ finish: json.candidates?.[0]?.finishReason, usage: json.usageMetadata, text }, null, 1)); }
    const finish = json.candidates?.[0]?.finishReason;
    return { pass: false, confidence: 0, violations: ['Compliance verdict unreadable'], finish, notes: `[${finish || 'no finish reason'}] ` + text.slice(0, 300) };
  }
}


/**
 * Majority-vote wrapper: run the judge `votes` times in parallel and pass only
 * if a majority pass. Smooths the judge's variance on hairline calls without
 * making it lenient — a real violation is flagged by most votes.
 * Returns the merged verdict plus the individual votes for the audit record.
 */
async function judgeComplianceVoted(apiKey, type, oB64, oMime, cB64, cMime, judgeModel, inventory, votes = 3) {
  const n = Math.max(1, votes | 0);
  const results = await Promise.all(Array.from({ length: n }, () =>
    judgeCompliance(apiKey, type, oB64, oMime, cB64, cMime, judgeModel, inventory)));
  const passes = results.filter(r => r.pass).length;
  const pass = passes * 2 > n;
  const tally = {};
  for (const r of results) for (const v of r.violations) tally[v] = (tally[v] || 0) + 1;
  // violations reported = those raised by a majority of votes; if failing with none
  // at majority, fall back to everything raised so the retry prompt still has feedback
  let violations = Object.keys(tally).filter(v => tally[v] * 2 > n);
  if (!pass && !violations.length) violations = Object.keys(tally);
  return {
    pass, votes: n, passes,
    confidence: +(results.reduce((a, r) => a + (r.confidence || 0), 0) / n).toFixed(2),
    violations,
    minor: [...new Set(results.flatMap(r => r.minor || []))],
    disproved: results.flatMap(r => r.disproved || []),
    notes: results.map(r => r.notes).filter(Boolean)[0] || '',
    individual: results,
  };
}

/**
 * THE TWO-SECOND BOUNCER (1 Sep 2026). Every candidate used to get the full
 * multi-vote jury even when it was obviously dead — a sofa parked across a
 * doorway costs three voted judge calls to refuse. This single cheap call
 * checks only the three instant-kill patterns from the audit history:
 * furniture standing in a keep-clear box, readable text or logos, and a
 * shifted camera. A candidate it kills skips the full jury (its violations
 * still feed the retry prompt and the repair pass); one it clears proceeds to
 * the real judging unchanged — the bouncer can refuse, never approve.
 * Deliberately biased against false kills: "when unsure, answer false."
 */
async function prescreenCandidate(apiKey, model, oB64, oMime, cB64, cMime, inventory) {
  const boxes = (inventory?.doors || []).filter(d => d.clear_zone).map(d => {
    const z = d.clear_zone;
    return `- ${d.name}: x ${z.x_from}%–${z.x_to}%, y ${z.y_from}%–${z.y_to}%`;
  }).join('\n');
  const prompt = `Image 1 is the original room photo. Image 2 is a virtually staged candidate. Answer THREE quick checks only — do not evaluate style or quality:
1. "blocked" — does any STANDING furniture in Image 2 (sofa, chair, table, lamp, game table, console) sit inside one of these keep-clear floor boxes (percent of frame, y from top), or obviously block a door or doorway?${boxes ? '\n' + boxes : ''}
2. "text" — was any readable text, brand name, or logo ADDED in Image 2 (on art, posters, boards, screens, or products)?
3. "camera" — is Image 2's camera position or framing clearly different from Image 1?
When unsure about any check, answer false — a wrong kill costs more than a wrong pass.
Respond with ONLY JSON: {"blocked": bool, "text": bool, "camera": bool, "details": ["one short sentence per true answer, naming the object and where"]}`;
  const body = {
    contents: [{ role: 'user', parts: [
      { text: prompt },
      { inline_data: { mime_type: oMime, data: oB64 } },
      { inline_data: { mime_type: cMime, data: cB64 } },
    ] }],
    generationConfig: { temperature: 0, response_mime_type: 'application/json' },
  };
  const { geminiGenerateContent } = require('./gemini');
  const json = await geminiGenerateContent(apiKey, model, body);
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  let v; try { v = JSON.parse(text); } catch { return null; }
  const dead = !!(v.blocked || v.text || v.camera);
  const details = (v.details || []).filter(Boolean).map(s => '[prescreen] ' + s);
  return { dead, violations: details.length ? details : dead ? ['[prescreen] failed a quick check'] : [] };
}

/**
 * THE PHANTOM CHECK, JURY EDITION (1 Sep 2026). A declutter of an
 * already-tidy nursery was refused 0/3 for "the wall-mounted TV was removed"
 * — with the TV plainly present in the refused frame. Near-identical image
 * pairs make vision judges invent differences, and the morning's phantom
 * check guarded only the overreach path, not the jury's own verdict. So:
 * every failing verdict whose violations claim something was REMOVED gets
 * one pointed look at the candidate per claim; claims about visibly-present
 * objects are struck. Bias: unsure keeps the violation — only confident
 * presence overturns testimony. If every violation dies, the verdict flips
 * to pass and says so in the audit (phantomCleared).
 */
const REMOVAL_CLAIM = /\b(was |were |been |improperly )?(removed|deleted|missing|absent|no longer (present|visible))\b/i;
async function vetRemovalClaims(apiKey, model, verdict, candB64, candMime) {
  if (!verdict || verdict.pass || !Array.isArray(verdict.violations) || !verdict.violations.length) return verdict;
  const claims = verdict.violations.filter(v => REMOVAL_CLAIM.test(String(v)));
  if (!claims.length) return verdict;
  const prompt = `Look at this photograph carefully. Each numbered sentence below claims that some object was REMOVED from (is absent from) this photo. For each one, answer whether the object it describes is actually VISIBLE in the photograph:
${claims.slice(0, 6).map((c, i) => `${i + 1}. ${String(c).slice(0, 180)}`).join('\n')}
When unsure, answer false — a wrong "visible" would overturn a judge.
Respond with ONLY JSON: {"items":[{"n":1,"visible":true|false,"where":"one short phrase if visible"}]}`;
  const body = {
    contents: [{ role: 'user', parts: [
      { text: prompt },
      { inline_data: { mime_type: candMime || 'image/jpeg', data: candB64 } },
    ] }],
    generationConfig: { temperature: 0, response_mime_type: 'application/json' },
  };
  let out;
  try {
    const json = await geminiGenerateContent(apiKey, model, body);
    out = JSON.parse(json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}');
  } catch { return verdict; }
  if (!out || !Array.isArray(out.items)) return verdict;
  const visible = new Set(out.items.filter(i => i && i.visible === true).map(i => i.n));
  const struck = claims.filter((_, i) => visible.has(i + 1));
  if (!struck.length) return verdict;
  const struckSet = new Set(struck);
  const remaining = verdict.violations.filter(v => !struckSet.has(v));
  const cleared = remaining.length === 0;
  if (struck.length) console.log(`  phantom check struck ${struck.length} removal claim(s) about visibly-present objects` + (cleared ? ' — verdict cleared' : ''));
  return { ...verdict, violations: remaining, pass: cleared ? true : verdict.pass,
           phantomStruck: struck, phantomCleared: cleared };
}

module.exports = { judgeCompliance, judgeComplianceVoted, prescreenCandidate, vetRemovalClaims, RULES, CHECKS };
