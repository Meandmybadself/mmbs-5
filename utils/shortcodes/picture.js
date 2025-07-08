const path = require('path')
const sharp = require('sharp')
const deasync = require('deasync')
const jsonfile = require('jsonfile')

// Twelvety options from .twelvety.js
const twelvety = require('@12ty')

// Image formats for picture
const formats = twelvety.imageFormats

// Asset shortcode for saving hashed assets
const saveAsset = require('./asset'), { hashContent } = saveAsset

// Sizes for responsive image - reduced from 12 to 4 key breakpoints
const SIZES = [640, 960, 1280, 1920] // Mobile, tablet, desktop, large desktop

// File to save responsive image cache
const CACHE_FILE = path.join(process.cwd(), '.twelvety.cache')

// Global cache to avoid reading file multiple times
let globalCache = null
let cacheLoaded = false

// Simple color palette for faster builds (instead of calculating)
const SIMPLE_COLORS = [
  'rgb(200,200,200)', 'rgb(180,180,180)', 'rgb(160,160,160)', 
  'rgb(140,140,140)', 'rgb(120,120,120)', 'rgb(100,100,100)'
]
let colorIndex = 0

// Function to deasync sharp functions (optimized)
function deasyncSharp(image, sharpFunction) {
  let result, error

  image[sharpFunction].bind(image)((err, data) => {
    error = err
    result = data
  })

  deasync.loopWhile(() => result === undefined && error === undefined)
  
  if (error) throw error
  return result
}

// Get image path from src
function getImagePath(src) {
  const index = src.indexOf(twelvety.dir.images)
  const position = index >= 0 ? index + twelvety.dir.images.length : 0
  const imageFilename = src.substring(position)
  return path.join(process.cwd(), twelvety.dir.input, twelvety.dir.images, imageFilename)
}

// Load cache from file or create new cache (only once)
function loadCache() {
  if (!cacheLoaded) {
    try {
      globalCache = jsonfile.readFileSync(CACHE_FILE)
    } catch {
      globalCache = {}
    }
    cacheLoaded = true
  }
  return globalCache
}

// Save cache (debounced to avoid frequent I/O)
let cacheWriteTimeout
function saveCache() {
  if (cacheWriteTimeout) clearTimeout(cacheWriteTimeout)
  cacheWriteTimeout = setTimeout(() => {
    jsonfile.writeFileSync(CACHE_FILE, globalCache, { spaces: 2 })
  }, 100)
}

// Save image as the given size and format (optimized)
function saveImageFormat(image, width, format, quality) {
  const formatted = image.clone().resize(width, null, {
    withoutEnlargement: true,
    fastShrinkOnLoad: true
  })[format]({ quality })

  const buffer = deasyncSharp(formatted, 'toBuffer')
  return saveAsset(buffer, format)
}

// Get a simple background color (much faster than calculating)
function getSimpleColor() {
  const color = SIMPLE_COLORS[colorIndex % SIMPLE_COLORS.length]
  colorIndex++
  return color
}

// Fast development mode - minimal processing
function generateDevImage(src, alt, loading) {
  // In development, just return a simple img tag with original image
  // Use the original image path from the assets directory
  const imageSrc = `/_assets/images/${src}`
  
  return `
    <picture style="background-color:rgb(200,200,200);">
      <img src="${imageSrc}" alt="${alt}" loading="${loading}" style="max-width: 100%; height: auto;">
    </picture>
  `
}

module.exports = function(src, alt, sizes = '90vw, (min-width: 1280px) 1152px', loading = 'lazy') {

  if (alt === undefined)
    throw new Error('Images should always have an alt tag')

  // Fast development mode
  if (process.env.ELEVENTY_ENV !== 'production') {
    return generateDevImage(src, alt, loading)
  }

  const imagePath = getImagePath(src)

  // Original image in sharp
  const original = sharp(imagePath)

  // Hash the original image
  const imageHash = hashContent(deasyncSharp(original, 'toBuffer'))

  // Load cache once
  const cache = loadCache()
  const cachePicture = cache.hasOwnProperty(imageHash) && cache[imageHash]

  // Get metadata from original image (only if not cached)
  let metadata
  if (!cachePicture) {
    metadata = deasyncSharp(original, 'metadata')
  }

  // Use simple color instead of expensive calculation
  const color = getSimpleColor()

  // Generate images for all formats and widths
  const images = Object.entries(formats).reduce((images, [format, quality]) => {
    // If format is `same` then use the same format as the input
    const actualFormat = format === 'same' ? (metadata?.format || 'jpeg') : format

    images[actualFormat] = SIZES.reduce((formatImages, width) => {
      // Use the cached image or save a new image
      formatImages[width] = (cachePicture && cachePicture[actualFormat] && cachePicture[actualFormat][width]) ||
        saveImageFormat(original, width, actualFormat, quality)
      return formatImages
    }, {})

    return images
  }, {})

  // Create descriptors for picture srcsets
  const descriptors = Object.entries(images).reduce((descriptors, [format, images]) => {
    descriptors[format] = Object.entries(images).map(([width, image]) => `${image} ${width}w`).join(',')
    return descriptors
  }, {})

  // Use input format as fallback format if possible
  const fallbackFormat = formats.hasOwnProperty('same') ? (metadata?.format || 'jpeg') : Object.keys(formats)[0]
  const fallback = images[fallbackFormat][SIZES[SIZES.length - 1]]

  // Render srcsets for picture
  const srcsets = Object.entries(descriptors).map(([format, descriptor]) => {
    return `<source srcset="${descriptor}" sizes="${sizes}" type="image/${format}">`
  }).join('\n      ')

  const picture = `
    <picture style="background-color:${color};">
      ${srcsets}
      <img src="${fallback}" alt="${alt}" loading="${loading}">
    </picture>
  `

  // Add images to cache
  globalCache[imageHash] = images

  // Save cache (debounced)
  saveCache()

  return picture
}
