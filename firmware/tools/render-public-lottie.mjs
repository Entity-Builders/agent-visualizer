import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PNG } from 'pngjs';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../../..');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const animationPath = resolve(repoRoot, 'node_modules/lottie-web/test/animations/starfish.json');
const lottiePlayerPath = resolve(repoRoot, 'node_modules/lottie-web/build/player/lottie_canvas.min.js');
const outputDir = resolve(repoRoot, 'apps/agent-visualizer/firmware/generated/public-lottie');
const headerPath = resolve(repoRoot, 'apps/agent-visualizer/firmware/src/public_lottie_frames.h');

const frameCount = 16;
const renderSize = 480;
const targetSize = 180;
const sourceStartFrame = 72;
const frameStride = 7;
const background = { r: 255, g: 255, b: 255 };
const contentThreshold = 18;

const toRgb565 = (r, g, b) => {
  const rgb565 = (((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)) & 0xffff;

  // LovyanGFX streams this PROGMEM pushImage buffer byte-wise on this GC9A01
  // setup. Store swapped words so RGB565 yellow remains yellow on hardware.
  return ((rgb565 & 0xff) << 8) | (rgb565 >> 8);
};

const buildRendererHtml = async (frame) => {
  const [animationData, lottiePlayer] = await Promise.all([
    readFile(animationPath, 'utf8'),
    readFile(lottiePlayerPath, 'utf8'),
  ]);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html,
      body {
        width: ${renderSize}px;
        height: ${renderSize}px;
        margin: 0;
        overflow: hidden;
        background: rgb(${background.r}, ${background.g}, ${background.b});
      }

      #stage {
        width: ${renderSize}px;
        height: ${renderSize}px;
      }
    </style>
  </head>
  <body>
    <div id="stage"></div>
    <script>${lottiePlayer}</script>
    <script>
      const animationData = ${animationData};
      const animation = lottie.loadAnimation({
        container: document.getElementById('stage'),
        renderer: 'canvas',
        loop: false,
        autoplay: false,
        animationData,
        rendererSettings: {
          clearCanvas: true,
          preserveAspectRatio: 'xMidYMid meet'
        }
      });

      animation.addEventListener('DOMLoaded', () => {
        animation.goToAndStop(${frame}, true);
        window.renderDone = true;
      });
    </script>
  </body>
</html>`;
};

const renderFrame = async (index) => {
  const sourceFrame = sourceStartFrame + index * frameStride;
  const htmlPath = resolve(outputDir, `frame-${String(index).padStart(2, '0')}.html`);
  const screenshotPath = resolve(outputDir, `frame-${String(index).padStart(2, '0')}.raw.png`);
  const html = await buildRendererHtml(sourceFrame);
  await writeFile(htmlPath, html);

  execFileSync(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${renderSize},${renderSize}`,
    '--virtual-time-budget=1400',
    `--screenshot=${screenshotPath}`,
    pathToFileURL(htmlPath).href,
  ], { stdio: 'ignore' });

  const normalizedBuffer = await sharp(screenshotPath)
    .resize(renderSize, renderSize, { fit: 'contain', background: { ...background, alpha: 1 } })
    .flatten({ background })
    .png()
    .toBuffer();

  return {
    index,
    screenshotPath,
    png: PNG.sync.read(normalizedBuffer),
  };
};

const getContentBox = (png) => {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const delta =
        Math.abs(png.data[offset] - background.r) +
        Math.abs(png.data[offset + 1] - background.g) +
        Math.abs(png.data[offset + 2] - background.b);

      if (delta > contentThreshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      minX: renderSize * 0.3,
      minY: renderSize * 0.3,
      maxX: renderSize * 0.7,
      maxY: renderSize * 0.7,
    };
  }

  return { minX, minY, maxX, maxY };
};

const getBoxSize = (box) => Math.max(box.maxX - box.minX + 1, box.maxY - box.minY + 1);

const toSquareCrop = (box, fixedSize) => {
  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  const centerX = box.minX + width / 2;
  const centerY = box.minY + height / 2;
  let size = fixedSize ?? Math.ceil(Math.max(width, height) * 1.34);

  size = Math.max(1, Math.min(Math.round(size), renderSize));

  let left = Math.round(centerX - size / 2);
  let top = Math.round(centerY - size / 2);

  left = Math.max(0, Math.min(left, renderSize - size));
  top = Math.max(0, Math.min(top, renderSize - size));

  return {
    left,
    top,
    width: size,
    height: size,
  };
};

const processFrame = async ({ index, screenshotPath }, crop) => {
  const finalPath = resolve(outputDir, `frame-${String(index).padStart(2, '0')}.png`);
  const normalizedBuffer = await sharp(screenshotPath)
    .resize(renderSize, renderSize, { fit: 'contain', background: { ...background, alpha: 1 } })
    .flatten({ background })
    .png()
    .toBuffer();
  const pngBuffer = await sharp(normalizedBuffer)
    .extract(crop)
    .resize(targetSize, targetSize, { fit: 'contain', background: { ...background, alpha: 1 } })
    .png()
    .toBuffer();

  await writeFile(finalPath, pngBuffer);
  return PNG.sync.read(pngBuffer);
};

const formatWords = (words) => {
  const lines = [];
  for (let i = 0; i < words.length; i += 12) {
    lines.push(`  ${words.slice(i, i + 12).map((word) => `0x${word.toString(16).padStart(4, '0')}`).join(', ')},`);
  }
  return lines.join('\n');
};

const main = async () => {
  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });

  const renderedFrames = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    renderedFrames.push(await renderFrame(frameIndex));
  }

  const boxes = renderedFrames.map(({ png }) => getContentBox(png));
  const cropSize = Math.min(renderSize, Math.ceil(Math.max(...boxes.map(getBoxSize)) * 1.34));
  const frames = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const crop = toSquareCrop(boxes[frameIndex], cropSize);
    const png = await processFrame(renderedFrames[frameIndex], crop);
    for (let pixel = 0; pixel < png.width * png.height; pixel += 1) {
      const offset = pixel * 4;
      frames.push(toRgb565(png.data[offset], png.data[offset + 1], png.data[offset + 2]));
    }
  }

  const header = `#pragma once

#include <Arduino.h>

// Generated from lottie-web's public MIT sample: test/animations/starfish.json.
// RGB565 words are byte-swapped for LovyanGFX pushImage on the GC9A01 target.
// Command: node apps/agent-visualizer/firmware/tools/render-public-lottie.mjs
constexpr uint16_t PUBLIC_LOTTIE_FRAME_WIDTH = ${targetSize};
constexpr uint16_t PUBLIC_LOTTIE_FRAME_HEIGHT = ${targetSize};
constexpr uint16_t PUBLIC_LOTTIE_FRAME_COUNT = ${frameCount};
constexpr uint32_t PUBLIC_LOTTIE_FRAME_PIXELS =
    PUBLIC_LOTTIE_FRAME_WIDTH * PUBLIC_LOTTIE_FRAME_HEIGHT;

const uint16_t PUBLIC_LOTTIE_FRAMES[] PROGMEM = {
${formatWords(frames)}
};
`;

  await writeFile(headerPath, header);
  console.log(`Generated ${frameCount} cropped frames at ${targetSize}x${targetSize}`);
  console.log(`Source frames: ${sourceStartFrame}-${sourceStartFrame + (frameCount - 1) * frameStride}`);
  console.log(`Crop size: ${cropSize}`);
  console.log(`Source: ${animationPath}`);
  console.log(`Header: ${headerPath}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
