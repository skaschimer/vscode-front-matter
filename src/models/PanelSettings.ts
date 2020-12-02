
export interface PanelSettings {
  seo: SEO;
  slug: Slug;
  tags: string[];
  categories: string[];
}

export interface SEO {
  title: number;
  description: number;
}

export interface Slug {
  prefix: number;
  suffix: number;
}