import React from "react";
import { cn } from "../utils";
import { useI18n } from "../i18n";

interface ModelFormatBadgeProps {
  isNinfer: boolean;
  compact?: boolean;
  children?: React.ReactNode;
  className?: string;
}

/**
 * 经典 Llama 羊驼矢量徽标 (代表 GGUF / llama.cpp 生态)
 * 具备高度辨识度的长双耳与昂首挺拔剪影，大模型开发者一眼即识
 */
export function GgufLlamaIcon({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("model-format-svg gguf-svg", className)}
    >
      {/* 羊驼标志性立耳与头颈轮廓 */}
      <path
        d="M8.5 7.5 L7.8 2.8 C7.6 2.2 8.4 1.7 8.9 2.1 L10.5 5.5 C11 5.2 11.8 5.2 12.3 5.5 L13.8 1.8 C14.3 1.4 15.1 1.9 14.9 2.5 L14.5 6 C15.5 6.6 17.5 7.6 18.5 8.4 C19.2 9 19.4 9.9 18.8 10.6 C18.2 11.3 17.2 11.5 16.5 11.2 L15.5 11.8 L15.5 21.5 C15.5 22 15 22 14.5 22 L8 22 C7.5 22 7 21.8 7 21 L7 13.5 C7 11 8.2 8.5 8.5 7.5 Z"
        fill="currentColor"
        fillOpacity="0.16"
      />
      {/* 灵动眼神点 */}
      <circle cx="14" cy="8.2" r="0.9" fill="currentColor" stroke="none" />
      {/* 鼻吻与微笑细节 */}
      <path d="M17.5 9.5 C17 10 16.2 10 15.5 9.8" strokeWidth="1.4" />
    </svg>
  );
}

/**
 * 极速六边形加速核心矢量徽标 (代表 Ninfer 高性能原生引擎)
 * 锐利的对称科技多边形与破空闪电脉冲，极速吞吐与并发感跃然眼前
 */
export function NinferTurboIcon({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("model-format-svg ninfer-svg", className)}
    >
      {/* 科技六边形框架 */}
      <path
        d="M12 2.5 L20.5 7.4 L20.5 16.6 L12 21.5 L3.5 16.6 L3.5 7.4 Z"
        fill="currentColor"
        fillOpacity="0.12"
      />
      {/* Turbo 极速破空闪电 */}
      <path
        d="M13 5 L8 12.5 H12.5 L11 19 L16.5 11.5 H12 Z"
        fill="currentColor"
        fillOpacity="0.28"
        strokeWidth="1.6"
      />
    </svg>
  );
}

/**
 * 模型格式专属徽标组件
 * 彻底分化 GGUF (羊驼紫) 与 NINFER (闪电绿) 的视觉认知体系
 */
export function ModelFormatBadge({ isNinfer, compact, children, className }: ModelFormatBadgeProps) {
  const { t } = useI18n();
  const title = isNinfer
    ? (t("models.formatNinferTitle") || "NINFER 格式 (专有高性能推理引擎)")
    : (t("models.formatGgufTitle") || "GGUF 格式 (llama.cpp 驱动)");

  const iconSize = compact ? 17 : 23;

  return (
    <div
      className={cn("model-symbol", isNinfer ? "ninfer" : "gguf", compact && "compact", className)}
      title={title}
      aria-label={title}
    >
      {children}
      <div className="model-symbol-icon">
        {isNinfer ? <NinferTurboIcon size={iconSize} /> : <GgufLlamaIcon size={iconSize} />}
      </div>
      <span className="model-symbol-tag">{isNinfer ? "NINFER" : "GGUF"}</span>
    </div>
  );
}
