/**
 * Listing Lab — what "declutter" means, enforced.
 *
 * WHY THIS EXISTS
 * Kyle ran the same bathroom through declutter twice, 40 minutes apart, same
 * settings. The first run left the trash can beside the toilet and kept the vase
 * and towels. The second run took the trash can, the vase, the towels and the
 * decorative dish. Neither result was wrong by the rules the system had, because
 * the system did not have a rule: a vision call catalogued a "keep list" before
 * each run, and whether it called a wooden vase *decor to protect* or *clutter to
 * remove* changed from run to run. The judge then dutifully enforced whichever
 * answer it got.
 *
 * Kyle's rule, 26 Aug 2026: remove the personal clutter — toiletries, trash,
 * laundry, papers, cords. Keep what the stager put there on purpose — the vase,
 * the tray, the towels, the art. So this file names both lists, and checks the
 * result against them in both directions:
 *
 *   TOO LITTLE — personal clutter still in the frame (his complaint)
 *   TOO MUCH   — a furnishing that was meant to stay is gone
 *
 * Both are narrow questions with closed answers, which is the only kind of
 * question a vision model answers reliably. Neither is a matter of taste: the
 * categories are fixed here, in code, not decided per photo.
 */
const { geminiGenerateContent } = require('./gemini');

/**
 * Goes, always. An agent asking for a declutter is asking for these to be gone.
 *
 * `gating: false` means the category is measured and recorded but never fails a
 * job. That distinction was not a guess — it came out of running the check across
 * eight ordinary rooms before letting it block anything:
 *
 *   k-living          cords(3/3) hanging along the lower right of the fireplace
 *   k-bedroom         cords(3/3) hanging below the wall-mounted TV
 *   living            cords(3/3) below the window air conditioner
 *   bedroom2-emptied  cords(3/3) from the AC to the wall outlet
 *
 * The model was right every time — those cords are there. But a room with a wall
 * TV or a window AC would then fail three attempts and be rejected over a cord
 * that belongs to the property, and erasing an appliance's power cord while
 * leaving the appliance is closer to idealising the home than tidying it.
 * Rejecting deliverable work is the worse failure, so cords are noted, not gated.
 * Personal photographs are the same call for a different reason: leaving one in
 * is a judgment about the seller's privacy, not a defect in the edit.
 */
const CLUTTER_CATEGORIES = Object.freeze([
  { key: 'trash_bin', label: 'a trash can, waste basket or bin (including a visible liner bag)' , gating: true },
  { key: 'toiletries', label: 'toiletries or bottles: soap, shampoo, lotion, toothbrush, razor, cleaning supplies' , gating: true },
  { key: 'grooming', label: 'grooming equipment left out: a tabletop magnifying or shaving mirror, hair dryer, straightener, brushes' , gating: true },
  { key: 'laundry', label: 'laundry, clothing, or shoes left out' , gating: true },
  /**
   * HUNG CLOTHES (restored 2 Sep 2026). Kyle's rule — "hanging clothes are
   * clutter, every garment on a rod goes, and the empty hangers too" — lived
   * only in the generation prompt's closet paragraph. When this list became
   * the single source of truth, the enforcement side inherited "laundry...
   * LEFT OUT", and clothes on a rod are not "left out": the segmenter never
   * targeted them, the leftover check never counted them, and the judge
   * passed a walk-in closet still packed with the seller's wardrobe (the 2pm
   * peak battery, graded a fail by Kyle). A rule only the generator knows
   * is a rule the pipeline does not have.
   */
  { key: 'hung_clothes', label: 'clothing hung on a closet rod, hooks, or the back of a door, and the hangers holding it (empty hangers too) — a closet is shown with its rods and shelving empty of the seller\'s wardrobe; the rod itself, its brackets, hooks and the shelving stay exactly as built' , gating: true },
  { key: 'paper', label: 'loose papers, mail, magazines, or sticky notes' , gating: true },
  { key: 'cords', label: 'loose cords, cables, or chargers lying about — NOT the single cord that runs from a kept lamp, TV or appliance to its outlet, which is part of that item (the cord rule)' , gating: false },
  // "including countertop organizers": Kyle's grade, 2 Sep 2026 — he passed a
  // delivered kitchen where the wooden chicken-wire display box (produce,
  // canisters, oils) went with everything else. A crate holding countertop
  // stuff is countertop stuff, not furniture.
  { key: 'dishes', label: 'dishes, glassware, food, or small counter appliances left out — including a countertop organizer, display box, crate or caddy holding food, produce, bottles or kitchenware (the organizer goes WITH its contents)' , gating: true },
  { key: 'pet', label: 'pet bowls, beds, litter trays or toys' , gating: true },
  /**
   * SEASONAL / HOLIDAY DECOR. Kyle's golden-set grade, 28 Aug 2026: a declutter
   * left "a random Christmas tree on the floor, small mini tree." Holiday decor is
   * temporary by definition — it does not convey with the house and dates the photo
   * to one season — so it goes with the personal clutter, not the styling that stays.
   */
  // "garland" alone caused a DEADLOCK (2 Sep 2026, Kyle's nursery): this
  // category flagged the decorative vine garland over the tapestry as
  // must-remove while the compliance jury killed any frame that removed it as
  // stripped decor — one object, both mandatory and forbidden to touch, so the
  // job could never pass. Holiday garland goes; everyday greenery is styling.
  { key: 'seasonal', label: 'seasonal or holiday decorations: a Christmas tree (real or artificial, any size), wreath, stocking, string lights, menorah, pumpkins, a HOLIDAY garland (pine, tinsel or lit), or other holiday-specific decor (an everyday decorative garland — vine, eucalyptus, plain greenery draped as styling — is NOT holiday decor: it stays)' , gating: true },
  /**
   * MESSY PILES / MISPLACED ITEMS. Kyle's golden-set grade, 28 Aug 2026: two frames
   * kept "junk on the couches" and "a vase on the floor and blankets on the couch."
   * The engine had been reading a blanket or vase as styling — which it is when
   * placed on purpose — and so protected it even heaped in a mess. The line is
   * PLACEMENT, not the object: a throw folded on a sofa arm or a vase on a shelf is
   * intentional styling and stays; the same throw thrown in a jumble across the seat,
   * belongings piled on the cushions, or an object dumped on the floor where it does
   * not belong is a mess the seller left, and it goes. Judgment call, so it is gated
   * only on a clear, visible pile — not on anything a stager could have placed.
   */
  { key: 'misplaced_pile', label: 'a clear mess of personal belongings out of place: clothing, blankets or linens heaped or jumbled on a sofa seat/back or the floor, a stack of miscellaneous items, or a small object (a vase, bowl, ornament) sitting on the floor where it plainly belongs on a surface (NEATLY placed, intentional styling — a folded throw, a vase on a shelf, a tall decorative floor vase — is NOT this and stays)' , gating: true },
  /**
   * PORTABLE APPLIANCES. The seller takes these with them.
   *
   * Added 27 Aug 2026 after Kyle saw the reconciler protect a box fan standing on
   * a side table: *"why would it keep a box fan? I consider that clutter."* He is
   * right, and the rule that protected it was wrong in a way that reached further
   * than one fan — "fans, heaters, air conditioners" sat in the keep list beside
   * actual furniture, which put a plug-in box fan in the same category as the
   * window AC unit bolted into the wall.
   *
   * The line is the one every agent already works to: DOES IT CONVEY? A window
   * AC, a baseboard heater, a radiator, a ceiling fan and anything mounted to
   * the building stay, because the buyer is getting them. A box fan on a table
   * is the occupant's, it leaves in the moving van, and a listing photo showing
   * it is showing the seller's belongings.
   */
  /**
   * STORED FURNITURE. Kyle's call, 27 Aug 2026, on a near-empty orange bedroom
   * whose only content was a mattress and box spring standing on edge against
   * the wall. Under the old wording that was a bed, a bed is furniture, and
   * furniture is a keeper — so the system would have carefully preserved a
   * mattress balanced on its side, which is nobody's idea of a listing photo.
   *
   * The distinction is not what the object IS but whether it is IN SERVICE. A
   * bed made up and standing on its feet furnishes the room and stays. The same
   * bed taken apart and leaned against a wall is a stored object: it tells a
   * buyer the room is being used to keep things in, not to sleep in, and it is
   * going out with the seller. Same for a table folded flat, a bed frame in
   * pieces, chairs stacked in a corner, a headboard behind a door.
   *
   * The test is deliberately narrow — leaning, stacked, folded flat, or in
   * pieces. Furniture merely pushed against a wall is still in use and stays.
   */
  { key: 'stored_furniture', label: 'furniture that is not in use but stored: a mattress or box spring leaning on its edge against a wall, a bed frame or table in pieces, a table folded flat, chairs stacked, a headboard or shelf leaning behind a door, a wall mirror or framed picture set down on the floor against a wall instead of hung — not a full-length floor mirror made to lean (furniture STANDING ON ITS FEET and in use is NOT this — it stays, even pushed up against a wall)' , gating: true },
  /**
   * `fatal: false` (Kyle's regrade, 2 Sep 2026): a leftover box fan is MINOR,
   * whatever its size. The fan SHOULD go — it stays a segmentation target and
   * a generation-prompt delete — but three of his graded passes had a fan
   * still standing and he stands by them: an appliance left behind reads as
   * an appliance, not as mess, and is never worth rejecting the photograph.
   * (`gating` alone can't express this: cords are gating:false because the
   * masked path must not TOUCH them; the fan is the opposite — touch it,
   * remove it, just don't fail over it.)
   */
  { key: 'portable_appliance', label: 'free-standing appliances the seller takes with them: a box fan or floor fan, space heater, dehumidifier, humidifier, air purifier, vacuum cleaner, portable AC, drying rack, or fold-up laundry hamper, and any kitchen appliance parked where it does not belong — a grill, toaster, microwave or blender sitting on a chair, sofa, bed or the floor (NOT anything fitted to the building — a window AC unit, baseboard heater, radiator, ceiling fan or wall-mounted unit CONVEYS and stays)' , gating: true, fatal: false },
  { key: 'personal', label: 'personal photographs of identifiable people' , gating: false },
  /**
   * TOYS, BABY GEAR, BOXES AND BAGS (2 Sep 2026). Kyle graded a delivered
   * nursery declutter "awful": the stuffed animals, diapers, hanging
   * organizer and baby gear all stayed. The jury's rule ALREADY called
   * "boxes, bags, toys" clutter — but only as words bolted onto one prompt in
   * compliance.js, never added to THIS list, which is the list the segmenter
   * traces and the leftover check counts. The lists drifted apart in exactly
   * the way this file's header warns about. Single source of truth again.
   */
  { key: 'toys', label: 'children\'s toys, stuffed animals, and play equipment left out — toy bins, activity centers, mobiles clipped to furniture (children\'s stuffed animals and toys are PERSONAL BELONGINGS, never decor or styling, even arranged neatly on a shelf or bed)' , gating: true },
  { key: 'baby_gear', label: 'baby and child gear: a stroller, high chair, car seat, baby swing or bouncer, playpen or pack-n-play, changing table, diaper caddy, hanging diaper or supply organizer, and changing supplies (diapers, wipes, creams) left out — this gear is the family\'s, it leaves with them, and it goes EVEN standing on its feet in use' , gating: true },
  { key: 'boxes_bags', label: 'boxes and bags out in the room: cardboard or storage boxes, shopping bags, luggage, backpacks, purses, plastic bags' , gating: true },
  // Kyle's rule, 2 Sep 2026: "all fridge decorations go on declutter."
  { key: 'fridge_decor', label: 'anything decorating or attached to the refrigerator\'s surface: magnets, signs, photos, children\'s drawings, bead garlands, notes, papers, calendars — the fridge itself stays, its doors wiped visually clean' , gating: true },
]);

/**
 * Stays, always. Removing one of these is over-reach, not a tidier photo.
 *
 * The test throughout is whether the thing CONVEYS — whether the buyer gets it
 * with the house. Furniture, styling and anything fitted to the building do.
 * What the seller carries out to the van does not, and that is the clutter list
 * above, not this one.
 */
const KEEPER_CATEGORIES = Object.freeze([
  'furniture IN USE, of any kind: beds, sofas, chairs, tables, desks, dressers, nightstands, shelving, benches, stools — furniture standing on its feet where it belongs, doing its job (furniture that has been DISASSEMBLED or STORED is NOT a keeper, and baby/child GEAR — a playpen, changing table, high chair, stroller — is gear that leaves with the family, NOT furniture; see the clutter list for both)',
  'anything fitted to the building, which conveys with it: window air conditioners, baseboard heaters, radiators, ceiling fans, wall-mounted units, vents, outlets and switches',
  'rugs and bath mats',
  'towels, whether hung, folded or rolled',
  'throw pillows and blankets arranged as styling — folded or draped neatly (a blanket heaped or jumbled in a mess on the seat or floor is clutter, not styling)',
  'decorative objects placed as intentional styling on a shelf, table, mantel or windowsill: vases, plants, trays, candles, bowls, ornaments (the same object dumped on the floor or heaped in a pile where it does not belong is clutter, not styling — and children\'s toys and stuffed animals are NEVER styling however neatly arranged; see the clutter list)',
  'electronics in use as part of the room: a desktop computer, monitor, laptop, or television and its stand — these read as a working home office or media area, and erasing them leaves a hard edge and an emptier room than the seller has',
  'wall art, framed prints, mirrors HUNG on the wall, and a tall full-length floor mirror that is MADE to stand leaning (a styling piece) — NOT a small tabletop grooming mirror, and NOT a wall mirror or framed picture set down on the floor against a wall waiting to be hung: that is stored, see clutter (the owner\'s grade, 5 Sep 2026: "it\'s on the ground so it\'s clutter")',
  'lamps and light fixtures',
  'curtains, drapes and blinds',
  'hearth accessories that belong with a fireplace or wood stove: the fireplace tool set, a log holder or rack with its firewood, a fireplace screen or grate, a wood-stove kettle (the owner\'s ruling, 5 Sep 2026: a delivered living room lost its tool set and log holder)',
]);

/** One line for a prompt, so the generator and the checks describe one rule. */
function clutterLine() {
  return CLUTTER_CATEGORIES.map(c => c.label).join('; ');
}
/**
 * Gating categories only — what the MASKED PATH is allowed to target (2 Sep
 * 2026). The full list includes cords and personal photos, which are recorded
 * but never fail a job; handing them to the segmenter meant the masked path
 * tried to ERASE a wall TV's cables — cables that stay with the TV — and the
 * half-successful erase was textbook ghosting, delivered to Kyle. A region
 * the pipeline is not required to clean is a region it must not touch.
 */
function gatingClutterLine() {
  return CLUTTER_CATEGORIES.filter(c => c.gating !== false).map(c => c.label).join('; ');
}
function keeperLine() {
  return KEEPER_CATEGORIES.join('; ');
}

async function ask(apiKey, model, parts) {
  const json = await geminiGenerateContent(apiKey, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
  });
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * TOO LITTLE: is any personal clutter still in the delivered frame?
 *
 * Asked of the result alone, category by category, with a closed answer set. It
 * is deliberately not "is this room tidy?" — that invites an opinion, and an
 * opinion is what let a trash can through.
 *
 * Votes, because a single call will occasionally invent a bottle. A category
 * counts as present only on a majority.
 */
async function verifyClutterGone(apiKey, model, afterB64, afterMime, votes = 3) {
  const prompt = `You are checking a real-estate photo that has just been decluttered for marketing.
For EACH category below, answer whether such an item is VISIBLE in this photo. Judge only what you can actually see; if you are unsure, answer "absent".
${CLUTTER_CATEGORIES.map(c => `- ${c.key}: ${c.label}`).join('\n')}
Respond with ONLY JSON: {"found":[{"category":"<key>","verdict":"present|absent","where":"short location in the frame","boxes":[[ymin,xmin,ymax,xmax]]}]}
For a "present" verdict, "boxes" holds ONE TIGHT box (normalized 0-1000) PER distinct visible item of that category — never one loose box spanning items in different parts of the room. Omit "boxes" for "absent".
Include every category exactly once.`;
  const parts = [{ text: prompt }, { inline_data: { mime_type: afterMime, data: afterB64 } }];
  const rounds = await Promise.all(Array.from({ length: votes }, () => ask(apiKey, model, parts).catch(() => null)));
  const tally = {}, where = {}, areas = {};
  let counted = 0;
  const boxPct = (b) => Array.isArray(b) && b.length === 4 && b.every(n => Number.isFinite(n) && n >= 0 && n <= 1000)
    ? Math.max(0, (b[2] - b[0])) * Math.max(0, (b[3] - b[1])) / 10000 : null;
  for (const r of rounds) {
    if (!r || !Array.isArray(r.found)) continue;
    counted++;
    for (const f of r.found) {
      if (f?.verdict !== 'present') continue;
      tally[f.category] = (tally[f.category] || 0) + 1;
      if (f.where && !where[f.category]) where[f.category] = String(f.where).slice(0, 120);
      // The vote's measurement is the SUM of its per-item boxes. One box per
      // item, because a single spanning box measures SPREAD, not clutter: two
      // bottles on opposite sides of a room boxed together came back as 13%
      // of the frame (2 Sep 2026 bench) — the actual bottles were under 0.1%.
      const list = Array.isArray(f.boxes) ? f.boxes : (f.box_2d ? [f.box_2d] : []);
      const pcts = list.map(boxPct).filter(p => p !== null);
      if (pcts.length) (areas[f.category] = areas[f.category] || []).push(pcts.reduce((s, p) => s + p, 0));
    }
  }
  if (!counted) return { skipped: true, reason: 'no usable answer', remaining: [], violations: [] };
  const need = Math.floor(counted / 2) + 1;
  const remaining = Object.entries(tally)
    .filter(([, n]) => n >= need)
    .map(([key, n]) => {
      const cat = CLUTTER_CATEGORIES.find(c => c.key === key) || {};
      // Median of the voters' box areas — one wild box does not decide.
      const a = (areas[key] || []).sort((x, y) => x - y);
      const areaPct = a.length ? +a[Math.floor(a.length / 2)].toFixed(2) : null;
      // A category's leftover is fatal only when it is both gating and fatal —
      // portable appliances are targeted for removal but demote to noted here.
      const fatal = cat.gating !== false && cat.fatal !== false;
      return { key, votes: `${n}/${counted}`, where: where[key] || null, areaPct,
        label: cat.label || key, gating: fatal,
        ...(cat.gating !== false && cat.fatal === false ? { demoted: 'minor by rule' } : {}) };
    });
  /**
   * TINY LEFTOVERS DELIVER (2 Sep 2026, Kyle's call after the nursery bench:
   * a declutter that cleared the room but left a soap bottle was a TOTAL
   * failure — "I will never make money this way"). When every gating leftover
   * has a measured box and together they cover no more than
   * LEFTOVER_DELIVER_PCT of the frame (default 1%), they demote to noted:
   * recorded, logged, never fatal. A 90% declutter is a sellable photo.
   * The area is arithmetic on the checker's boxes — a category the checker
   * couldn't box stays gating (unmeasured means unproven-small).
   */
  const LEFTOVER_DELIVER_PCT = parseFloat(process.env.LEFTOVER_DELIVER_PCT || '1.5');
  const gatingLeft = remaining.filter(r => r.gating);
  const allBoxed = gatingLeft.length > 0 && gatingLeft.every(r => r.areaPct !== null);
  const leftoverPct = allBoxed ? +gatingLeft.reduce((s, r) => s + r.areaPct, 0).toFixed(2) : null;
  if (allBoxed && leftoverPct <= LEFTOVER_DELIVER_PCT) {
    for (const r of gatingLeft) { r.gating = false; r.demoted = 'tiny leftover'; }
  }
  return {
    skipped: false, votes: counted, tally, remaining, leftoverPct,
    noted: remaining.filter(r => !r.gating),
    violations: remaining.filter(r => r.gating)
      .map(r => `Still in the photo after the declutter: ${r.label}${r.where ? ` (${r.where})` : ''}.`),
  };
}

/**
 * TOO MUCH: did the edit take something that was meant to stay?
 *
 * Text only, and cheap: it classifies the list `verifyRemoval` already produced
 * rather than looking at the images again. Three buckets, and only the clear
 * "furnishing" bucket is a violation — an ambiguous item (a trinket dish, a
 * half-used candle) is not worth failing a job the agent is waiting on.
 */
async function classifyRemovals(apiKey, model, items, candidate = null) {
  const list = (items || []).map(s => String(s).slice(0, 160)).filter(Boolean);
  if (!list.length) return { skipped: true, reason: 'nothing removed', overreach: [], violations: [] };
  const prompt = `A real-estate photo was decluttered. These items were removed from it:
${list.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Classify each one:
- "clutter" if it belongs to this list: ${clutterLine()}
- "furnishing" if it belongs to this list: ${keeperLine()}
- "unclear" if it is neither clearly one nor the other, or the description is too vague to tell.
Prefer "unclear" over "furnishing" when you are not certain.
Respond with ONLY JSON: {"items":[{"item":"<repeat the item>","class":"clutter|furnishing|unclear"}]}`;
  const r = await ask(apiKey, model, [{ text: prompt }]);
  if (!r || !Array.isArray(r.items)) return { skipped: true, reason: 'no usable answer', overreach: [], violations: [] };
  let overreach = r.items.filter(i => i?.class === 'furnishing').map(i => String(i.item).slice(0, 160));
  /**
   * THE PHANTOM CHECK (1 Sep 2026). A declutter was refused for "removing"
   * a small black stool that was PLAINLY still in the refused frame — the
   * removal list this function classifies is itself a judge's testimony, and
   * that judge hallucinated. Before an overreach claim may kill a candidate,
   * one pointed look at the candidate itself: is the item visible? If it is,
   * nothing was removed and the claim is struck. Costs one call, only when a
   * kill is otherwise about to happen.
   */
  let struck = [];
  if (overreach.length && candidate && candidate.data) {
    const check = await ask(apiKey, model, [
      { text: `Look at this photograph. For each item below, answer whether it is VISIBLE in the photograph (anywhere in frame):
${overreach.map((s2, i) => `${i + 1}. ${s2}`).join('\n')}
Respond with ONLY JSON: {"items":[{"item":"<repeat>","present":true|false}]}` },
      { inline_data: { mime_type: candidate.mime_type || 'image/jpeg', data: candidate.data } },
    ]).catch(() => null);
    if (check && Array.isArray(check.items)) {
      const presentSet = new Set(check.items.filter(i => i?.present === true).map(i => String(i.item).slice(0, 160)));
      struck = overreach.filter(i => presentSet.has(i));
      overreach = overreach.filter(i => !presentSet.has(i));
    }
  }
  return {
    skipped: false, classified: r.items, overreach, struck,
    violations: overreach.map(i => `Removed something that is part of how the room is styled, not clutter: ${i}.`),
  };
}

/**
 * MAJOR APPLIANCES SELL WITH THE HOME. Kyle, 3 Sep 2026, after the soak
 * test's emptied kitchen came back without its range: "removing the range is
 * never acceptable. Even in an empty room. Appliances like fridge, stove all
 * stay — they sell with the home almost 99 percent of the time." One list,
 * quoted by every prompt, the fixed-elements catalogue and every judge rule.
 */
const APPLIANCES_STAY = 'the refrigerator, range or stove, cooktop, wall oven, range hood, dishwasher, built-in or over-the-range microwave, washer, dryer, water heater and furnace or boiler';
const APPLIANCE_RULE = `MAJOR APPLIANCES STAY, ALWAYS: ${APPLIANCES_STAY} sell with the home and remain exactly as photographed in every transformation, an emptied room included. Only their clutter goes — magnets and papers off the refrigerator, items off the counters, laundry off the machines. The appliance itself is never removed, replaced, relocated, or turned into countertop or cabinet.`;

module.exports = {
  APPLIANCES_STAY, APPLIANCE_RULE,
  CLUTTER_CATEGORIES, KEEPER_CATEGORIES, clutterLine, keeperLine, gatingClutterLine,
  verifyClutterGone, classifyRemovals,
};
