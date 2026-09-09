# Listing Lab — the pipeline container.
#
# Runs Kyle's existing Node pipeline unchanged. The only reason this image exists
# is `sharp`: it is a compiled binary used for every crop, resize and watermark,
# and Cloudflare Workers cannot run compiled binaries. Everything else about the
# product lives in the Worker.

FROM node:22-slim

# sharp ships prebuilt binaries for this platform, but its build fallback needs
# these if it ever has to compile. Cheap insurance against a silent install
# failure that would only show up as a broken crop in production.
# FONTS ARE NOT OPTIONAL. The disclosure watermark is drawn as SVG text and
# rendered by sharp; node:22-slim ships with no fonts at all, so every letter
# comes out as an empty box. The first real job through the deployed container
# produced a watermark reading as a row of tofu rectangles instead of
# "VIRTUALLY DECLUTTERED" — a legally meaningful mark rendered as gibberish.
# fonts-liberation provides metric-compatible Helvetica/Arial, which is exactly
# what watermark.js asks for.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The pipeline, exactly as it runs locally. Copied before the harness so a change
# to server.js does not invalidate the pipeline's dependency layer.
COPY pipeline/package.json pipeline/package-lock.json ./pipeline/
RUN cd pipeline && npm ci --omit=dev

COPY pipeline/ ./pipeline/

# The harness that turns an HTTP request into a `node transform.js` run.
COPY container/server.js ./server.js

# .env is deliberately NOT copied. The Gemini key arrives as an environment
# variable from Cloudflare's secret store; baking a key into an image is how it
# ends up somewhere it should not be. The .dockerignore excludes it; this line
# makes the promise ENFORCED — the build fails loudly if a key ever sneaks in.
RUN test ! -f pipeline/.env && test ! -f .env || (echo 'SECURITY: .env found in image build' && exit 1)
ENV NODE_ENV=production \
    PIPELINE_DIR=/app/pipeline \
    PORT=8080

EXPOSE 8080

# Fail fast and visibly if sharp did not install properly — a container that
# starts but cannot crop would pass every check and produce unverified images.
RUN cd pipeline && node -e "require('sharp'); console.log('sharp ok')"

CMD ["node", "/app/server.js"]
