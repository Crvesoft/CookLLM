import { useEffect, useRef, useState } from "react";

/** 动态监听容器尺寸，保证 SVG 在 1:1 坐标系下渲染，圆形与描边绝对保真、不被拉伸变形 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 330, height: 110 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        setSize({
          width: Math.round(entry.contentRect.width),
          height: Math.round(entry.contentRect.height),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size] as const;
}

/** 将离散折线坐标转换为平滑三次贝塞尔曲线及闭合面积路径，消除生硬尖锐折角 */
export function pointsToSmoothPath(
  pts: [number, number][],
  baselineY: number,
  padT: number
): { lineD: string; areaD: string } {
  if (pts.length < 2) return { lineD: "", areaD: "" };
  if (pts.length === 2) {
    const [p0, p1] = pts;
    const dx = p1[0] - p0[0];
    const cp1x = p0[0] + dx * 0.45;
    const cp2x = p1[0] - dx * 0.45;
    const lineD = `M ${p0[0].toFixed(1)} ${p0[1].toFixed(1)} C ${cp1x.toFixed(1)} ${p0[1].toFixed(1)}, ${cp2x.toFixed(1)} ${p1[1].toFixed(1)}, ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
    const areaD = `${lineD} L ${p1[0].toFixed(1)} ${baselineY.toFixed(1)} L ${p0[0].toFixed(1)} ${baselineY.toFixed(1)} Z`;
    return { lineD, areaD };
  }

  // 多轮次使用 Catmull-Rom 三次贝塞尔样条平滑，消除剧烈的锯齿折角
  const tension = 0.2;
  let lineD = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];

    let cp1x = p1[0] + (p2[0] - p0[0]) * tension;
    let cp1y = p1[1] + (p2[1] - p0[1]) * tension;

    let cp2x = p2[0] - (p3[0] - p1[0]) * tension;
    let cp2y = p2[1] - (p3[1] - p1[1]) * tension;

    // 约束控制点不超出图表上下边界
    cp1y = Math.max(padT, Math.min(baselineY, cp1y));
    cp2y = Math.max(padT, Math.min(baselineY, cp2y));

    lineD += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }

  const startX = pts[0][0].toFixed(1);
  const endX = pts[pts.length - 1][0].toFixed(1);
  const bY = baselineY.toFixed(1);
  const areaD = `${lineD} L ${endX} ${bY} L ${startX} ${bY} Z`;

  return { lineD, areaD };
}
