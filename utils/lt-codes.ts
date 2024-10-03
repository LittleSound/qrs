interface EncodedHeader {
  /**
   * Number of original data blocks
   */
  k: number
  /**
   * Data length for Uint8Array data
   */
  length: number
  /**
   * Checksum
   */
  sum: number
}

export interface EncodedBlock extends EncodedHeader {
  indices: number[]
  data: Uint8Array
}

export function blockToBinary(block: EncodedBlock): Uint8Array {
  const { k, length, sum, indices, data } = block
  const header = new Uint32Array([
    indices.length,
    ...indices,
    k,
    length,
    sum,
  ])
  const binary = new Uint8Array(header.length * 4 + data.length)
  let offset = 0
  binary.set(new Uint8Array(header.buffer), offset)
  offset += header.length * 4
  binary.set(data, offset)
  return binary
}

export function binaryToBlock(binary: Uint8Array): EncodedBlock {
  const degree = new Uint32Array(binary.buffer, 0, 4)[0]!
  const headerRest = Array.from(new Uint32Array(binary.buffer, 4, degree + 3))
  const indices = headerRest.slice(0, degree)
  const [
    k,
    length,
    sum,
  ] = headerRest.slice(degree) as [number, number, number]
  const data = binary.slice(4 * (degree + 4))
  return {
    k,
    length,
    sum,
    indices,
    data,
  }
}

// CRC32 checksum
function checksum(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc = crc ^ data[i]!
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1
    }
  }
  return crc ^ 0xFFFFFFFF
}

// Use Ideal Soliton Distribution to select degree
function getRandomDegree(k: number): number {
  const probabilities: number[] = Array.from({ length: k }, () => 0)

  // Calculate the probabilities of the Ideal Soliton Distribution
  probabilities[0] = 1 / k // P(1) = 1/k
  for (let d = 2; d <= k; d++) {
    probabilities[d - 1] = 1 / (d * (d - 1))
  }

  // Accumulate the probabilities to generate the cumulative distribution
  const cumulativeProbabilities: number[] = probabilities.reduce((acc, p, index) => {
    acc.push(p + (acc[index - 1] || 0))
    return acc
  }, [] as number[])

  // Generate a random number between [0,1] and select the corresponding degree in the cumulative probabilities
  const randomValue = Math.random()
  for (let i = 0; i < cumulativeProbabilities.length; i++) {
    if (randomValue < cumulativeProbabilities[i]!) {
      return i + 1
    }
  }

  return k // Theoretically, this line should never be reached
}

// Randomly select indices of degree number of original data blocks
function getRandomIndices(k: number, degree: number): number[] {
  const indices: Set<number> = new Set()
  while (indices.size < degree) {
    const randomIndex = Math.floor(Math.random() * k)
    indices.add(randomIndex)
  }
  return Array.from(indices)
}

function xorUint8Array(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) {
    result[i] = a[i]! ^ b[i]!
  }
  return result
}

function sliceData(data: Uint8Array, blockSize: number): Uint8Array[] {
  const blocks: Uint8Array[] = []
  for (let i = 0; i < data.length; i += blockSize) {
    const block = new Uint8Array(blockSize)
    block.set(data.slice(i, i + blockSize))
    blocks.push(block)
  }
  return blocks
}

export function *encodeFountain(data: Uint8Array, indiceSize: number): Generator<EncodedBlock> {
  const sum = checksum(data)
  const indices = sliceData(data, indiceSize)
  const k = indices.length
  const meta: EncodedHeader = {
    k,
    length: data.length,
    sum,
  }

  while (true) {
    const degree = getRandomDegree(k)
    const selectedIndices = getRandomIndices(k, degree)
    let encodedData = new Uint8Array(indiceSize)

    for (const index of selectedIndices) {
      encodedData = xorUint8Array(encodedData, indices[index]!)
    }

    yield {
      ...meta,
      indices: selectedIndices,
      data: encodedData,
    }
  }
}

export function createDecoder(blocks?: EncodedBlock[]) {
  return new LtDecoder(blocks)
}

export class LtDecoder {
  public decodedData: (Uint8Array | undefined)[] = []
  public decodedCount = 0
  public encodedCount = 0
  public encodedBlocks: Set<EncodedBlock> = new Set()
  public meta: EncodedBlock = undefined!

  public encodedData = new Map<string, EncodedBlock>()

  constructor(blocks?: EncodedBlock[]) {
    if (blocks) {
      this.addBlock(blocks)
    }
  }

  /**
   * 存储一些中间包含的数据，用于解码
   * 每收到一个新的包，就遍历它的 ids，将这些 ids 对应的数据也计算一次异或得到新的数据。
   * 如果这个数据的大小等于 1，那么就说明这个数据已经解码完成，将这个数据存储到 decodedData 中。
   */
  addBlock2(blocks: EncodedBlock[]): boolean {
    blocks = Array.from(blocks)
    if (!blocks.length) {
      return false
    }
    if (!this.meta) {
      this.meta = blocks[0]!
      this.decodedData = Array.from({ length: this.meta.k })
    }

    const strIncludesSet = new Set<string>()
    blocks.forEach((block) => {
      strIncludesSet.add(block.indices.sort((a, b) => a - b).join(','))
    })

    let count = 0
    for (const block of blocks) {
      count++
      if (count > 250) {
        throw new Error('Too many blocks')
      }

      const { data, indices, sum } = block
      const strIndices = indices.sort((a, b) => a - b).join(',')

      if (sum !== this.meta.sum) {
        throw new Error('Adding block with different checksum')
      }

      if (!this.encodedData.has(strIndices)) {
        this.encodedData.set(strIndices, block)
        this.encodedBlocks.add(block)

        if (indices.length === 1 && this.decodedData[indices[0]!] == null) {
          this.decodedData[indices[0]!] = data
          this.decodedCount++
        }
      }

      for (const otherBlock of this.encodedData.values()) {
        const indicesSet = new Set(indices)
        const otherIndicesSet = new Set(otherBlock.indices)
        const inter = intersection(indicesSet, otherIndicesSet)
        const diff = symmetricDifference(inter, inter)
        if (inter.size !== 0 && diff.size !== 0) {
          const newIndices = Array.from(diff)
          const strNewIndices = newIndices.sort((a, b) => a - b).join(',')

          if (!strIncludesSet.has(strNewIndices) && !this.encodedData.has(strNewIndices)) {
            strIncludesSet.add(strNewIndices)

            const data = xorUint8Array(block.data, otherBlock.data)
            const newBlock: EncodedBlock = {
              ...this.meta,
              k: newIndices.length,
              indices: newIndices,
              data,
            }

            blocks.push(newBlock)
          }
        }
      }
    }

    return this.decodedCount === this.meta.k
  }

  // Add blocks and decode them on the fly
  addBlock(blocks: EncodedBlock[]): boolean {
    if (!blocks.length) {
      return false
    }

    if (!this.meta) {
      this.meta = blocks[0]!
      this.decodedData = Array.from({ length: this.meta.k })
    }

    for (const block of blocks) {
      if (block.sum !== this.meta.sum) {
        throw new Error('Adding block with different checksum')
      }
      this.encodedBlocks.add(block)
      this.encodedCount += 1
    }

    let updated = true

    while (updated) {
      updated = false

      for (const block of this.encodedBlocks) {
        let { data, indices } = block

        // We already have all the data from this block
        if (indices.every(index => this.decodedData[index] != null)) {
          this.encodedBlocks.delete(block)
          continue
        }

        // XOR the data
        for (const index of indices) {
          if (this.decodedData[index] != null) {
            block.data = data = xorUint8Array(data, this.decodedData[index]!)
            block.indices = indices = indices.filter(i => i !== index)
            updated = true
          }
        }

        // Use 1x2x3 XOR 2x3 to get 1
        if (indices.length >= 3) {
          const lowerBlocks = Array.from(this.encodedBlocks).filter(i => i.indices.length === indices.length - 1)
          for (const lower of lowerBlocks) {
            const extraIndices = indices.filter(i => !lower.indices.includes(i))
            if (extraIndices.length === 1 && this.decodedData[extraIndices[0]!] == null) {
              const extraData = xorUint8Array(data, lower.data)
              const extraIndex = extraIndices[0]!
              this.decodedData[extraIndex] = extraData
              this.decodedCount++
              this.encodedBlocks.delete(lower)
              updated = true
            }
          }
        }

        if (indices.length === 1 && this.decodedData[indices[0]!] == null) {
          this.decodedData[indices[0]!] = data
          this.decodedCount++
          this.encodedBlocks.delete(block)
          updated = true
        }
      }
    }

    return this.decodedCount === this.meta.k
  }

  getDecoded(): Uint8Array | undefined {
    if (this.decodedCount !== this.meta.k) {
      return
    }
    if (this.decodedData.some(block => block == null)) {
      return
    }
    const indiceSize = this.meta.data.length
    const blocks = this.decodedData as Uint8Array[]
    const decodedData = new Uint8Array(this.meta.length)
    blocks.forEach((block, i) => {
      const start = i * indiceSize
      if (start + indiceSize > decodedData.length) {
        for (let j = 0; j < decodedData.length - start; j++) {
          decodedData[start + j] = block[j]!
        }
      }
      else {
        decodedData.set(block, i * indiceSize)
      }
    })
    const sum = checksum(decodedData)
    if (sum !== this.meta.sum) {
      throw new Error('Checksum mismatch')
    }
    return decodedData
  }
}

export function stringToUint8Array(str: string): Uint8Array {
  const data = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    data[i] = str.charCodeAt(i)
  }
  return data
}

export function symmetricDifference(a: Set<number>, b: Set<number>): Set<number> {
  const result = new Set<number>(a)
  for (const item of b) {
    if (result.has(item)) {
      result.delete(item)
    }
    else {
      result.add(item)
    }
  }
  return result
}
export function intersection(a: Set<number>, b: Set<number>): Set<number> {
  const result = new Set<number>()
  for (const item of a) {
    if (b.has(item)) {
      result.add(item)
    }
  }
  return result
}
