import { Download, ExternalLink, Flame, Star } from "lucide-react";
import { memo } from "react";
import { useI18n } from "../../i18n";
import type { HfModel } from "../../types";
import { cn } from "../../utils";
import ModelAvatar from "./ModelAvatar";
import { formatCount, openHf, openMs, paramLabel, quantLabel, quantSpecsOf } from "./modelUtils";

interface ModelRowProps {
  model: HfModel;
  preferredQuant: boolean;
  rank?: number;
  onViewFiles: (model: HfModel) => void;
}

/** memo：进度轮询/悬浮等引起的父级重渲染不再逐行重算 paramLabel/quantSpecsOf */
const ModelRow = memo(function ModelRow({ model, preferredQuant, rank, onViewFiles }: ModelRowProps) {
  const { t } = useI18n();
  const parameter = paramLabel(model);
  const quant = quantLabel(model);
  const quantSpecs = quantSpecsOf(model);
  const updated = model.updatedAt ? model.updatedAt.slice(0, 10) : "";
  const fileCount = model.ggufCount >= 0 ? model.ggufCount : null;
  const isNinfer = Boolean(
    model.id.toLowerCase().includes("ninfer") ||
    model.name?.toLowerCase().includes("ninfer") ||
    model.tags?.some((tag) => tag.toLowerCase().includes("ninfer"))
  );
  const isGguf = Boolean(
    model.id.toLowerCase().includes("gguf") ||
    model.name?.toLowerCase().includes("gguf") ||
    model.tags?.some((tag) => tag.toLowerCase().includes("gguf"))
  );
  const isSafetensors = Boolean(
    model.id.toLowerCase().includes("safetensors") ||
    model.name?.toLowerCase().includes("safetensors") ||
    model.tags?.some((tag) => tag.toLowerCase().includes("safetensors"))
  );

  const formatLabels: string[] = [];
  if (isGguf) formatLabels.push("GGUF");
  if (isNinfer) formatLabels.push("NINFER");
  if (isSafetensors && !isGguf && !isNinfer) formatLabels.push("Safetensors");
  const formatLabel = formatLabels.join(" · ");

  const metaBits = [
    updated ? t("explore.metaUpdated", { date: updated }) : "",
    fileCount != null ? t("explore.metaFiles", { count: fileCount }) : "",
    formatLabel,
  ].filter(Boolean);
  if (quantSpecs.length > 1) metaBits.push(t("explore.quantSpecs", { quants: quantSpecs.join("/") }));
  return (
    <div className={cn("hf-model-row", preferredQuant && "hf-model-row-preferred", rank != null && `hf-model-ranked rank-${rank}`)}>
      <div className="hf-model-row-body">
        {rank != null && (
          <div className={cn("model-rank-badge", rank === 1 ? "top-1" : rank === 2 ? "top-2" : rank === 3 ? "top-3" : "top-n")} title={`TOP ${rank}`}>
            {rank <= 3 && <Flame size={12} className="rank-flame" />}
            <span>{rank <= 3 ? `TOP ${rank}` : rank < 10 ? `#0${rank}` : `#${rank}`}</span>
          </div>
        )}
        <div className="hf-model-main-col">
          <div className="hf-model-title-row">
            <ModelAvatar author={model.author} source={model.source} />
            <strong title={model.id}>{model.id}</strong>
            {isGguf && <span className="hf-format-pill gguf" title={t("models.formatGgufTitle")}>GGUF</span>}
            {isNinfer && <span className="hf-format-pill ninfer" title={t("models.formatNinferTitle")}>NINFER</span>}
            {isSafetensors && !isGguf && !isNinfer && <span className="hf-format-pill safetensors" title="Safetensors 格式">SAFE</span>}
            {preferredQuant && <span className="hf-quant-badge preferred" title={t("explore.quantPreferred", { quant: quant || "" })}><Star size={10} fill="currentColor" />{quant}</span>}
            {parameter && <span className="hf-param-badge" title={t("explore.facetParams")}>{parameter}</span>}
            {quant && !preferredQuant && <span className="hf-quant-badge" title={t("explore.facetQuant")}>{quant}</span>}
            <button
              className="hf-model-link"
              type="button"
              title={model.source === "ms" ? t("explore.openOnMs") : t("explore.openOnHf")}
              aria-label={model.source === "ms" ? t("explore.openOnMs") : t("explore.openOnHf")}
              onClick={(event) => {
                event.stopPropagation();
                if (model.source === "ms") openMs(model.id);
                else openHf(model.id);
              }}
            >
              <ExternalLink size={14} />
            </button>
          </div>
          <span className="hf-model-desc">{metaBits.join(" · ")}</span>
        </div>
        <div className="hf-model-side-col">
          <div className="hf-model-meta">
            <span className="likes" title={model.likes.toLocaleString()}><Star size={12} fill="currentColor" />{formatCount(model.likes)}</span>
            <span title={model.downloads.toLocaleString()}><Download size={12} />{formatCount(model.downloads)}</span>
          </div>
          <div className="hf-model-actions">
            <button className="secondary-button compact" onClick={() => onViewFiles(model)}><Download size={13} />{t("explore.viewFilesShort")}</button>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ModelRow;
