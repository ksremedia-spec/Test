/**
 * Listing Lab — layout analysis (staging only).
 * A vision call locates every door/opening and fixed obstacle in the photo
 * and expresses them as KEEP-CLEAR zones in plain image coordinates
 * (percent of frame width/height). Those zones are injected into the staging
 * prompt and handed to the judge, so "don't block the door" becomes a concrete
 * region of the picture instead of an abstract rule.
 */
const { geminiGenerateContent } = require('./gemini');

async function analyzeLayout(apiKey, imageB64, mime, model, roomType) {
  const prompt = `You are planning virtual staging for this empty-room photo. Identify every DOOR (entry, interior, closet), DOORWAY/OPENING, STAIR, and HALF-WALL/RAILING, plus every window, light switch, thermostat, outlet, and baseboard heater.
For each door/opening, describe: which wall it is on (left/back/right), its horizontal span in the frame as percent of image width (x_from..x_to), and the floor area that must stay clear so it can open and be walked through — expressed as a percent-of-frame box on the floor (x_from, x_to, y_from, y_to, where y is from the top).
SIZING THE CLEAR BOX: it is the door's swing arc plus a walking strip — roughly one door-width deep into the room, no more. For a wide cased opening or pass-through between rooms, the clear box is a shallow THRESHOLD STRIP along the opening (about 8–12% of frame height deep), not the whole floor in front of it. A clear box must never cover more than ~12% of the total frame area; if it would, shrink it to the threshold strip. Stairs: the strip at the bottom tread only.
This room will be staged as a ${roomType || 'room'}. Also state where the main furniture grouping for a ${roomType || 'room'} SHOULD go (the largest floor area that does not touch any clear zone), and which wall can take the anchor piece (${roomType && /bed|nursery/i.test(roomType) ? 'the bed/crib headboard' : roomType && /dining|kitchen/i.test(roomType) ? 'the table' : roomType && /office/i.test(roomType) ? 'the desk' : 'the sofa or main seating'}) without overlapping any window or door.
Respond with ONLY JSON:
{"doors":[{"name":"white 6-panel entry door on the right wall","wall":"right","x_from":70,"x_to":95,"clear_zone":{"x_from":60,"x_to":100,"y_from":55,"y_to":100}}],
 "fixed":["window, back wall, x 48-62","light switch, right wall beside door, x 71, y 53", ...],
 "placement":"one or two sentences on where furniture should and should not go"}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: imageB64 } }] }],
    generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
  };
  const json = await geminiGenerateContent(apiKey, model, body);
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  try {
    const v = JSON.parse(text);
    const doors = (v.doors || []).map(d => {
      const z = d.clear_zone; if (!z) return d;
      // Hard cap: a clear box may cover at most 12% of the frame; shrink to a threshold strip if larger.
      const area = Math.max(0, z.x_to - z.x_from) * Math.max(0, z.y_to - z.y_from);
      if (area > 1200) d.clear_zone = { ...z, y_to: Math.min(z.y_to, z.y_from + Math.max(6, Math.floor(1200 / Math.max(1, z.x_to - z.x_from)))) };
      return d;
    });
    return { doors, fixed: v.fixed || [], placement: v.placement || '' };
  }
  catch { return { doors: [], fixed: [], placement: '' }; }
}

function layoutText(layout) {
  if (!layout || !layout.doors.length) return '';
  const zones = layout.doors.map(d => {
    const z = d.clear_zone || {};
    return `- ${d.name} (${d.wall} wall, spanning ${d.x_from}%–${d.x_to}% of the frame width). KEEP CLEAR: the floor from ${z.x_from}% to ${z.x_to}% of the frame width and from ${z.y_from}% to ${z.y_to}% of the frame height. Nothing standing — no sofa end, chair, table, lamp, plant, or bench — may appear inside that box (a flat rug edge is tolerated).`;
  }).join('\n');
  return `\n\nLAYOUT PLAN measured from this photo (percentages of the image frame, y from the top):\n${zones}\nFixed elements that must stay visible and uncovered: ${layout.fixed.join('; ')}.\nPlacement: ${layout.placement}\nThe finished image must show empty floor in every KEEP CLEAR box.`;
}

/**
 * THE RED-BOX REFERENCE (1 Sep 2026, "improve speed and success at the same
 * time"). The keep-clear zones were already in the staging prompt as
 * coordinates — and blocked doorways stayed the #1 rejection cause anyway:
 * text coordinates are weak instructions to an image model. Vision models
 * follow DRAWN boxes far better, so the same zones are painted onto a copy of
 * the photo as translucent red boxes and ride along as a reference image.
 * Returns null when there is nothing to draw.
 */
async function drawNoGoReference(sharp, originalBuf, layout) {
  const zones = (layout?.doors || []).map(d => d.clear_zone).filter(Boolean);
  if (!zones.length) return null;
  const meta = await sharp(originalBuf).metadata();
  const W = meta.width, H = meta.height;
  const rects = zones.map(z => {
    const x = Math.max(0, W * z.x_from / 100), y = Math.max(0, H * z.y_from / 100);
    const w = Math.max(1, W * (z.x_to - z.x_from) / 100), h = Math.max(1, H * (z.y_to - z.y_from) / 100);
    return `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" fill="rgba(255,0,0,0.22)" stroke="#FF0000" stroke-width="${Math.max(4, Math.round(W / 300))}"/>`;
  }).join('');
  const svg = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`);
  const buf = await sharp(originalBuf).composite([{ input: svg }]).jpeg({ quality: 85 }).toBuffer();
  return {
    label: 'PLANNING REFERENCE — the SAME room with its KEEP-CLEAR floor zones shaded red (door swings and walking paths). Nothing you place — no sofa end, chair, table, lamp, plant, game table, or bench — may stand inside a red zone. The red shading is a planning overlay and is NOT part of the room: your output contains no red boxes, no outlines, no tint.',
    mime_type: 'image/jpeg',
    data: buf.toString('base64'),
  };
}

module.exports = { analyzeLayout, layoutText, drawNoGoReference };
