export type Candidate = 'all' | 'sandstone' | 'ore' | 'crate'
export type Layout = 'terrace' | 'organic'
export type View = 'home' | 'front' | 'back' | 'close'
export type Quality = 'high' | 'low'

export const candidates = [
  { id: 'sandstone' as const, number: '01', name: '暖砂岩', subtitle: '温润 · 扎实', description: '圆润的切角与细腻石纹，让储备像一块块积累下来的基石。', color: '#c8ac7b' },
  { id: 'ore' as const, number: '02', name: '青矿石', subtitle: '自然 · 有机', description: '灰青矿面与浅色矿脉，保留自然轮廓，与海岸岩石呼应。', color: '#688b88' },
  { id: 'crate' as const, number: '03', name: '橡木箱', subtitle: '生活 · 秩序', description: '木板、束带和金属钉，把每一份储备变成可以搬运的货物。', color: '#a97948' },
]

export const art = {
  exposure: 1.0,
  sun: { position: [-4, 9, 6] as [number, number, number], intensity: 3.05, color: '#fff0da' },
  ambient: { sky: '#cde7ee', ground: '#8a7b63', intensity: .96 },
  camera: { home: [11.8, 12.5, 17] as [number, number, number], target: [0, .7, 0] as [number, number, number], minDistance: 6.2, maxDistance: 38 },
}
