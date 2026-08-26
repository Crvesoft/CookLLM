/**
 * 应用内品牌标记：与程序图标 / 启动页 logo 同一张图（public/CookLLM.png）
 */
export function LlamaMark({ size = 21 }: { size?: number }) {
  return <img width={size} height={size} src="/CookLLM.png" alt="CookLLM" aria-hidden="true" />;
}
