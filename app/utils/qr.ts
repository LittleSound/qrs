import { encode, type QrCodeGenerateData, type QrCodeGenerateSvgOptions } from 'uqr'

/**
 * This function accepts data from two channels, appends padding to the shorter one (unless they are
 * of equal length), encodes them into QR codes, and renders them into SVG.
 *
 * @param ch1 data from the channel 1
 * @param ch2 data from the channel 2
 * @param options QrCodeGenerateSvgOptions
 * @returns SVG string
 */
export function renderSVGDual(ch1: QrCodeGenerateData, ch2: QrCodeGenerateData, options: QrCodeGenerateSvgOptions = {}) {
  const padding = ' '.repeat(Math.abs(ch1.length - ch2.length))

  const ch1data = encode(ch1.length > ch2.length ? ch1 : `${ch1}${padding}`, options)
  const ch2data = encode(ch2.length > ch1.length ? ch2 : `${ch2}${padding}`, options)

  const { pixelSize = 10 } = options
  const size = ch1data.size
  const height = size * pixelSize
  const width = size * pixelSize

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`

  let ch1path = ''
  let ch2path = ''
  let bothPath = ''

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const x = col * pixelSize
      const y = row * pixelSize
      const onCh1 = ch1data.data[row]?.[col]
      const onCh2 = ch2data.data[row]?.[col]

      if (onCh1 && onCh2) {
        bothPath += `M${x},${y}h${pixelSize}v${pixelSize}h-${pixelSize}z`
      }
      else if (onCh1) {
        ch1path += `M${x},${y}h${pixelSize}v${pixelSize}h-${pixelSize}z`
      }
      else if (onCh2) {
        ch2path += `M${x},${y}h${pixelSize}v${pixelSize}h-${pixelSize}z`
      }
    }
  }

  svg += `<rect fill="white" width="${width}" height="${height}"/>`
  // This allows the "black" blocks remain "dark" in the RED/BLUE-only channel while decoding
  svg += `<path fill="rgb(0, 255, 255)" d="${ch1path}"/>`
  svg += `<path fill="rgb(255, 255, 0)" d="${ch2path}"/>`
  svg += `<path fill="rgb(0, 0, 0)" d="${bothPath}"/>`

  svg += '</svg>'
  return svg
}
