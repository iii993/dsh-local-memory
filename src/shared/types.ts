/** 跨模块共享的类型。放这里是为了避免模块之间为了一个类型声明来回互相 import。 */

/** 插件行的 config 形状。 */
export interface MemoryConfig {
  memoryRoot?: string
}
