// This generates the embed code that business owners paste into their site.
// It's a single <script> tag — nothing else needed.

export function generateEmbedCode(tenantId: string, options?: {
  apiHost?: string;
  position?: "bottom-right" | "bottom-left";
  primaryColor?: string;
}): string {
  const host = options?.apiHost || "https://api.whisp.so";
  const config = {
    tenantId,
    position: options?.position || "bottom-right",
    primaryColor: options?.primaryColor || "#6366f1",
  };

  return `<!-- Website Context Chat Widget -->
<script>
(function(w,d,c){
  w.__wctx=c;
  var s=d.createElement('script');
  s.src='${host}/widget.js';
  s.async=true;
  d.head.appendChild(s);
})(window,document,${JSON.stringify(config)});
</script>`;
}

// Alternative: web component approach for more control
export function generateWebComponentEmbed(tenantId: string, options?: {
  apiHost?: string;
}): string {
  const host = options?.apiHost || "https://api.whisp.so";

  return `<!-- Website Context Chat Widget -->
<script src="${host}/widget.js" async></script>
<website-context-chat tenant="${tenantId}"></website-context-chat>`;
}
