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
 * 几何双色调剪影，保留立耳与头颈辨识度并提升小尺寸锐度
 */
export function GgufLlamaIcon({ size = 27, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("model-format-svg gguf-svg", className)}
    >
      <path
        d="M7.2 21 V11.4 C7.2 9.4 7.8 7.5 8.4 6.5 L7.9 3.1 C7.8 2.4 8.6 2.1 9.1 2.6 L10.9 5.3 C11.4 5.1 12.0 5.1 12.5 5.3 L14.1 2.5 C14.6 2.0 15.4 2.3 15.3 3.0 L14.8 6.3 C16.0 6.9 17.8 7.7 18.8 8.6 C19.5 9.2 19.4 10.4 18.6 11.0 C17.9 11.5 16.7 11.5 15.7 11.1 L15.1 11.5 V21 C15.1 21.4 14.8 21.6 14.4 21.6 H7.9 C7.5 21.6 7.2 21.4 7.2 21 Z"
        fill="currentColor"
        fillOpacity="0.22"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path
        d="M9.6 20.8 V14.2 C9.6 12.8 10.6 11.8 12.0 11.8 H14.3"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeOpacity="0.45"
      />
      <circle cx="14.3" cy="8.2" r="1.0" fill="currentColor" />
    </svg>
  );
}

/**
 * 极速右冲飞翼矢量徽标 (代表 Ninfer 原生高性能推理引擎)
 * 光滑前缘向右破风、三羽向左上后掠并伴随双重速度尾迹，呼应 2× 极速吞吐特性
 */
export function NinferTurboIcon({ size = 27, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("model-format-svg ninfer-svg", className)}
    >
      <path
        d="M2.4 17.8 H7.2 M4.2 20.4 H9.6"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeOpacity="0.55"
      />
      <path
        d="M19.8 12.2 C15.5 11.4 10.5 8.2 4.2 3.6 C3.6 3.2 3.0 3.9 3.4 4.6 C4.6 6.8 6.0 8.5 7.5 9.8 L3.8 9.4 C3.3 9.4 3.1 10.0 3.5 10.4 C5.2 12.0 7.2 13.2 9.4 14.0 L6.0 14.2 C5.5 14.2 5.4 14.9 5.9 15.2 C8.6 16.8 12.0 17.6 15.4 17.6 C17.2 17.6 18.8 16.2 19.8 12.2 Z"
        fill="currentColor"
        fillOpacity="0.22"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M16.4 14.2 C12.8 13.0 9.5 10.8 6.4 7.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeOpacity="0.45"
      />
    </svg>
  );
}

/**
 * 模型格式专属徽标组件（纯图形图标框 + 外部格式胶囊配合使用）
 */
export function ModelFormatBadge({ isNinfer, compact, children, className }: ModelFormatBadgeProps) {
  const { t } = useI18n();
  const title = isNinfer
    ? (t("models.formatNinferTitle") || "NINFER 格式 (专有高性能推理引擎)")
    : (t("models.formatGgufTitle") || "GGUF 格式 (llama.cpp 驱动)");

  const iconSize = compact ? 20 : 27;

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
    </div>
  );
}
