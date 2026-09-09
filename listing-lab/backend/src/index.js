/**
 * Listing Lab — the Cloudflare entry point.
 *
 * Deliberately thin. `worker.js` holds the whole API and imports nothing that
 * only exists inside Wrangler's bundler, which is what lets the test suite run
 * every route against a real SQLite database in plain Node. The container class
 * below DOES need the bundler, so it lives here instead — one import away from
 * the code under test rather than inside it.
 */

import { Container } from '@cloudflare/containers';
import worker from './worker.js';

/**
 * The pipeline container.
 *
 * Cloudflare addresses a container through a Durable Object class, so most of
 * this is ceremony. The parts that matter:
 *
 * `sleepAfter` keeps a warm instance between jobs. A cold start pays for Node
 * booting and sharp loading its native binary on every single photo — dead time
 * an agent spends watching a spinner.
 *
 * The Gemini key is injected here rather than baked into the image, so rotating
 * it is a secret update and a redeploy, not an image rebuild. The pipeline reads
 * `GEMINI_API_KEY` from its environment exactly as it does on a laptop.
 */
export class PipelineContainer extends Container {
  defaultPort = 8080;

  /**
   * THE LEGACY KILL (2 Sep 2026). The cycle order asks an instance to drain
   * politely — but an instance still on an image from before /cycle existed
   * answers 404 and lingers, exactly the mixed-version straggler the cycle
   * was built to end. This DO class ships with the WORKER, so it is current
   * even when the container image is not: when the polite knock gets a 404,
   * destroy the container outright. The next request boots fresh on the
   * current image. Only /cycle carries this hammer, and only on 404 — a
   * modern instance drains gently and running jobs finish.
   */
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/cycle') {
      let r = null;
      try { r = await super.fetch(req); } catch { /* fall through to the kill */ }
      if (r && r.status !== 404) return r;
      try {
        await this.ctx.container.destroy();
      } catch (e) {
        return Response.json({ cycled: false, error: String(e && e.message || e).slice(0, 120) }, { status: 500 });
      }
      return Response.json({ cycled: 'destroyed', legacy: true });
    }
    return super.fetch(req);
  }
  // Short, so a finished instance releases its slot quickly. A long idle time
  // holds slots that other jobs need — with a small pool that is the difference
  // between a job starting and a job never starting.
  sleepAfter = '3m';

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = {
      /**
       * The container talks to Google DIRECTLY.
       *
       * It could not on 25 Aug — Google refused its egress with
       * "User location is not supported for the API use" — so every call was
       * routed back out through the Worker. That detour cost more than it looked:
       * Cloudflare cuts a Worker's own outbound fetch at 125 seconds, so any
       * generation Google took longer than two minutes to produce died on our own
       * infrastructure. It killed three of Kyle's jobs on 26 Aug, including a
       * twilight, and no amount of retrying could have helped.
       *
       * Re-measured from inside the container on 26 Aug via /internal/diag/egress:
       *
       *   geoBlocked: false, reachedGoogle: true, egress 104.28.166.125 (ORD, US)
       *   Google's answer to a deliberately invalid key: "API key not valid"
       *
       * The block is gone, so the detour goes, and the ceiling with it. The
       * diagnostic stays in place to ask the same question again cheaply if this
       * ever regresses.
       *
       * Setting GEMINI_VIA_WORKER=1 in wrangler.toml puts the proxy back without a
       * code change — one flip, if Google ever reinstates the block.
       */
      GEMINI_API_KEY: env.GEMINI_API_KEY,
      /**
       * The way back in when Google refuses this instance by location.
       *
       * Not a switch anyone has to flip. The container tries Google directly,
       * and if it is told "User location is not supported for the API use" it
       * routes through the Worker — which egresses from an address Google
       * accepts — for the rest of that instance's life. One refused request,
       * once, instead of a dead job.
       *
       * Why it has to be per-instance and not a deploy-time setting: Cloudflare
       * places containers across its network and each egresses from wherever it
       * landed. On 26 Aug 2026 one instance answered from ATL and worked
       * perfectly while another, same image, same key, same minute, was refused
       * and killed a staging job five seconds in.
       *
       * GEMINI_VIA_WORKER=1 still forces the proxy from the first call, for
       * the case where every instance is blocked and the first failure per
       * instance is not worth paying.
       */
      GEMINI_PROXY_URL: `${env.SITE_URL}/internal/gemini`,
      GEMINI_PROXY_KEY: env.PIPELINE_SECRET,
      ...(env.GEMINI_VIA_WORKER === '1'
        ? { GEMINI_BASE_URL: `${env.SITE_URL}/internal/gemini` }
        : {}),
      // IMAGE_SIZE is set to 2K in wrangler.toml, deliberately — see the comment
      // there. Left unset, the pipeline chooses per photograph instead, which is
      // the right behaviour but costs the slow half of jobs about two minutes
      // and twice the money for resolution the MLS discards anyway.
      ...(env.IMAGE_SIZE ? { IMAGE_SIZE: env.IMAGE_SIZE } : {}),
      /**
       * The second door.
       *
       * `gemini-3-pro-image` is reachable two ways and they draw on different
       * capacity. On 26 Aug 2026 the developer API returned 500 — "currently
       * experiencing high demand" — for over an hour, while the identical
       * prompt through Vertex came back with a picture in it. Given both keys,
       * the pipeline knocks once at the first door and uses the other if it is
       * jammed, so the outage never reaches the customer.
       *
       * Unset, nothing changes: one door, full retry patience, and a job that
       * waits in the retry queue if Google is down everywhere.
       */
      ...(env.VERTEX_API_KEY ? { VERTEX_API_KEY: env.VERTEX_API_KEY } : {}),
      /**
       * The backup judge. When Google's judge models go down WITH its image
       * model (seen 31 Aug 2026), a finished generation can sit unapprovable.
       * With this key set, every judge/classify/room-plan call falls through
       * to Anthropic during a Google outage — see pipeline/anthropic.js.
       * Unset, nothing changes.
       */
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      /**
       * The third door: fal.ai serves the SAME pro image model from its own
       * capacity. Knocked only when both Google doors are jammed, before any
       * fallback to flash — see pipeline/fal.js. Unset, nothing changes.
       */
      ...(env.FAL_KEY ? { FAL_KEY: env.FAL_KEY } : {}),
      // FAL_FIRST=0 restores the Google-first generation order (1 Sep 2026).
      ...(env.FAL_FIRST ? { FAL_FIRST: env.FAL_FIRST } : {}),
      // PIXEL_GUARD=0 disables the fixed-feature pixel snap (on by default).
      ...(env.PIXEL_GUARD ? { PIXEL_GUARD: env.PIXEL_GUARD } : {}),
      ...(env.PROVIDER ? { PROVIDER: env.PROVIDER } : {}),
      JUDGE_MODEL: env.JUDGE_MODEL || 'gemini-3.6-flash',
    };
  }
}

export default worker;
