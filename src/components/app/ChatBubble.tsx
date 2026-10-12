/**
 * One turn of the chat (rule 1222): the owner's on the inline end in ink, an agent's on the inline start with the
 * agent's name above it. `wide` gives a turn that carries cards most of the row. No hooks, so the chat panel and the home
 * page's gallery draw the same bubble.
 */
export default function ChatBubble({ role, name, wide = false, children }: { role: "user" | "assistant"; name?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}>
      <div className={`${wide ? "w-full max-w-[95%]" : "max-w-[85%]"} rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${role === "user" ? "bg-inverse text-inverse-muted" : "bg-background-muted text-foreground"}`} dir="auto">
        {name && <span className="mb-1 block text-xs font-semibold text-foreground">{name}</span>}
        {children}
      </div>
    </div>
  );
}
