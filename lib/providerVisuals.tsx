import type { Provider } from "./types";
import {
  CATEGORY_COLORS,
  PROVIDER_CATEGORY,
  type ProviderCategory,
} from "./providerCategories";

interface CategoryDotProps {
  category?: ProviderCategory;
  provider?: Provider;
  size?: number;
  className?: string;
  title?: string;
}

export function CategoryDot({
  category,
  provider,
  size = 8,
  className,
  title,
}: CategoryDotProps) {
  const cat: ProviderCategory =
    category ?? (provider ? PROVIDER_CATEGORY[provider] : "open_local");
  const color = CATEGORY_COLORS[cat];
  return (
    <span
      role={title ? "img" : "presentation"}
      aria-label={title}
      title={title}
      className={`inline-block rounded-full shrink-0 align-middle ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
      }}
    />
  );
}
