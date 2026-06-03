// Logique front du chat. Appelle /api/chat (serverless). Aucune cle API ici.

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const suggestions = document.getElementById("suggestions");

const history = []; // [{role, content}] envoye au backend

// Rendu Markdown minimal et sur (echappement + sous-ensemble : gras, code,
// liens, listes, paragraphes). Pas de HTML brut depuis la reponse.
function renderMarkdown(text) {
  const esc = (s) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const inline = (s) =>
    esc(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => {
        const safeUrl = u.replace(/"/g, "%22");
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  const lines = text.split("\n");
  let html = "";
  let listType = null;

  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html += "<ul>";
      }
      html += `<li>${inline(ul[1])}</li>`;
    } else if (ol) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html += "<ol>";
      }
      html += `<li>${inline(ol[1])}</li>`;
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function addMessage(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg--${role === "user" ? "user" : "bot"}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "user") bubble.textContent = text;
  else bubble.innerHTML = renderMarkdown(text);
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

function showTyping() {
  const wrap = document.createElement("div");
  wrap.className = "msg msg--bot";
  wrap.innerHTML =
    '<div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>';
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap;
}

async function ask(question) {
  addMessage("user", question);
  history.push({ role: "user", content: question });
  if (suggestions) suggestions.style.display = "none";

  input.value = "";
  input.disabled = true;
  sendBtn.disabled = true;
  const typing = showTyping();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json().catch(() => ({}));
    typing.remove();

    if (!res.ok) {
      addMessage("bot", data.error || "Une erreur est survenue. Reessaie.");
      return;
    }
    const reply = data.reply || "Je n'ai pas de reponse a fournir sur ce point.";
    addMessage("bot", reply);
    history.push({ role: "assistant", content: reply });
  } catch {
    typing.remove();
    addMessage("bot", "Connexion impossible. Verifie ton reseau et reessaie.");
  } finally {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (q) ask(q);
});

if (suggestions) {
  suggestions.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) ask(chip.textContent.trim());
  });
}