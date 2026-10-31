/* ==========================================================================
   HISTORY PAGE CONTROLLER (public/js/history.js)
   Handles:
   1. Search & Filter (Searches Title + Message Content)
   2. Star / Unstar Toggle with Database Persistence
   3. Dropdown Menu Toggle
   4. Formatted File Exports (PDF, Word, Text with Table Formatting)
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
    // ----------------------------------------------------------------------
    // 1. SEARCH & "IMPORTANT ONLY" FILTERING
    // ----------------------------------------------------------------------
    const searchInput = document.getElementById("searchInput");
    const starFilterBtn = document.getElementById("starFilterBtn");
    let showImportantOnly = false;

    function runFilters() {
        const query = searchInput ? searchInput.value.toLowerCase().trim() : "";
        const searchWords = query.split(/\s+/).filter(w => w.length > 0);
        const cards = document.querySelectorAll(".convo-card");

        cards.forEach((card) => {
            const title = (card.getAttribute("data-title") || "").toLowerCase();
            const content = (card.getAttribute("data-content") || "").toLowerCase();
            
            // Search through BOTH the conversation title and the message content
            const fullSearchText = title + " " + content;
            const isImportant = card.getAttribute("data-important") === "1";
// FIXED (OR logic - shows any chat matching at least one word):
const matchesSearch = searchWords.length === 0 || searchWords.some(word => fullSearchText.includes(word));
            const matchesStar = !showImportantOnly || isImportant;

            card.style.display = (matchesSearch && matchesStar) ? "flex" : "none";
        });
    }

    if (searchInput) {
        searchInput.addEventListener("input", runFilters);
    }

    if (starFilterBtn) {
        starFilterBtn.addEventListener("click", () => {
            showImportantOnly = !showImportantOnly;
            starFilterBtn.classList.toggle("active", showImportantOnly);
            runFilters();
        });
    }

    // ----------------------------------------------------------------------
    // 2. TOGGLE STAR (IMPORTANT) STATUS IN DATABASE
    // ----------------------------------------------------------------------
    document.querySelectorAll(".btn-star").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const convoId = btn.getAttribute("data-convo-id");
            const card = document.getElementById(`convo-card-${convoId}`);
            if (!convoId || !card) return;

            try {
                const response = await fetch(`/toggle-star/${convoId}`, {
                    method: "POST",
                    headers: {
                        "Accept": "application/json",
                        "Content-Type": "application/json"
                    }
                });

                const data = await response.json();
                if (!response.ok || !data.success) {
                    throw new Error(data.error || "Failed to update star in database");
                }

                const isNowStarred = data.is_important === true || data.is_important === 1 || data.is_important === "1";

                // Update DOM attributes and classes
                card.setAttribute("data-important", isNowStarred ? "1" : "0");
                card.classList.toggle("is-starred", isNowStarred);
                btn.classList.toggle("starred", isNowStarred);
                btn.textContent = isNowStarred ? "★ Starred" : "☆ Mark Important";
                btn.title = isNowStarred ? "Unmark important" : "Mark as important";

                // Re-apply filters if "Important Only" view is active
                runFilters();
            } catch (err) {
                console.error("Star toggle error:", err);
                alert("Could not update important status.");
            }
        });
    });

    // ----------------------------------------------------------------------
    // 3. EXPORT MENU DROPDOWN TOGGLE
    // ----------------------------------------------------------------------
    document.querySelectorAll(".btn-export").forEach((exportBtn) => {
        exportBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const convoId = exportBtn.getAttribute("data-convo-id");
            const targetMenu = document.getElementById(`export-menu-${convoId}`);

            // Close all other open export menus
            document.querySelectorAll(".export-menu").forEach((menu) => {
                if (menu !== targetMenu) {
                    menu.classList.remove("show");
                }
            });

            // Toggle the clicked menu
            if (targetMenu) {
                targetMenu.classList.toggle("show");
            }
        });
    });

    // Close any open export menu when clicking anywhere else on the page
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".export-dropdown")) {
            document.querySelectorAll(".export-menu").forEach((menu) => {
                menu.classList.remove("show");
            });
        }
    });

    // ----------------------------------------------------------------------
    // 4. MARKDOWN TO HTML CONVERTER (TABLES, FORMATTING)
    // ----------------------------------------------------------------------
    function parseMarkdownToHtml(mdText) {
        if (!mdText) return "";

        // If markdown-it CDN is present, use it for complete table and list support
        if (window.markdownit) {
            const md = window.markdownit({ html: true, breaks: true, linkify: true });
            return md.render(mdText);
        }

        // Native table parser fallback
        let html = mdText;
        html = html.replace(/(?:^|\n)(\|.+?\|[\r\n]+\|[-:\s|]+?\|[\r\n]+(?:\|.+?\|[\r\n]*)+)/g, (match) => {
            const rows = match.trim().split("\n").filter(r => r.trim().startsWith("|"));
            if (rows.length < 2) return match;

            const headerRow = rows[0];
            const dataRows = rows.slice(2);

            let tableHtml = `<table style="width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 11pt;">`;
            tableHtml += `<thead><tr style="background-color: #8b263e; color: #ffffff;">`;
            headerRow.split("|").filter((c, i, a) => i > 0 && i < a.length - 1).forEach((cell) => {
                tableHtml += `<th style="border: 1px solid #6b1d30; padding: 8px 12px; text-align: left;">${cell.trim()}</th>`;
            });
            tableHtml += `</tr></thead><tbody>`;

            dataRows.forEach((row, idx) => {
                const bg = idx % 2 === 0 ? "#ffffff" : "#fbf2f4";
                tableHtml += `<tr style="background-color: ${bg};">`;
                row.split("|").filter((c, i, a) => i > 0 && i < a.length - 1).forEach((cell) => {
                    tableHtml += `<td style="border: 1px solid #d5c0c6; padding: 8px 12px; text-align: left;">${cell.trim()}</td>`;
                });
                tableHtml += `</tr>`;
            });

            tableHtml += `</tbody></table>`;
            return `\n${tableHtml}\n`;
        });

        html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
        html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
        html = html.replace(/\n/g, "<br>");
        return html;
    }

    function triggerDownload(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }

    // ----------------------------------------------------------------------
    // 5. EXPORT HANDLER (PDF, WORD, TEXT)
    // ----------------------------------------------------------------------
    document.querySelectorAll(".export-option").forEach((option) => {
        option.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const convoId = option.getAttribute("data-convo-id");
            const format = option.getAttribute("data-format");
            const card = document.getElementById(`convo-card-${convoId}`);
            const title = card ? card.querySelector(".convo-title").textContent.trim() : "Conversation";
            const dateStr = card && card.querySelector(".convo-date") ? card.querySelector(".convo-date").textContent.trim() : new Date().toLocaleString();
            const safeFileName = (title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)) || `chat_${convoId}`;

            try {
                const response = await fetch(`/export-convo/${convoId}?format=json`);
                if (!response.ok) throw new Error("Could not retrieve conversation content.");
                const data = await response.json();
                const messages = data.messages || [];

                // A. Plain Text (.txt)
                if (format === "txt") {
                    let text = `========================================================\n`;
                    text += `CONVERSATION: ${title.toUpperCase()}\n`;
                    text += `SAVED ON:     ${dateStr}\n`;
                    text += `========================================================\n\n`;

                    messages.forEach((m) => {
                        const sender = m.role === "user" ? "YOU" : "AI ASSISTANT";
                        text += `[${sender}]\n${m.content.trim()}\n\n--------------------------------------------------------\n\n`;
                    });

                    triggerDownload(text, `${safeFileName}.txt`, "text/plain;charset=utf-8");
                } 
                // B. Word Document (.doc) with Formatted Tables
                else if (format === "word") {
                    let bodyHtml = "";
                    messages.forEach((m) => {
                        const isUser = m.role === "user";
                        const borderColor = isUser ? "#8b263e" : "#2e7d32";
                        const bgColor = isUser ? "#fdf5f7" : "#f4f9f4";
                        const contentHtml = parseMarkdownToHtml(m.content);

                        bodyHtml += `
                            <div style="margin-bottom: 20px; padding: 14px 18px; background-color: ${bgColor}; border-left: 5px solid ${borderColor};">
                                <div style="font-weight: bold; color: ${borderColor}; text-transform: uppercase; font-size: 11pt; margin-bottom: 8px;">
                                    ${isUser ? "You" : "AI Assistant"}
                                </div>
                                <div style="font-size: 11pt; line-height: 1.6; color: #111;">
                                    ${contentHtml}
                                </div>
                            </div>`;
                    });

                    const wordDoc = `
                        <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
                        <head><meta charset='utf-8'><title>${title}</title>
                        <style>
                            table { border-collapse: collapse; width: 100%; margin: 12px 0; }
                            th { background-color: #8b263e; color: #ffffff; padding: 8px 12px; border: 1px solid #5a1e2d; text-align: left; }
                            td { padding: 8px 12px; border: 1px solid #ccc; text-align: left; }
                        </style>
                        </head>
                        <body style="font-family: Calibri, Arial, sans-serif; padding: 30px;">
                            <h1 style="color: #8b263e; border-bottom: 2px solid #8b263e; padding-bottom: 6px;">${title}</h1>
                            <p style="color: #666; font-size: 10pt; margin-bottom: 20px;">Saved on: ${dateStr}</p>
                            ${bodyHtml}
                        </body>
                        </html>`;
                    triggerDownload(wordDoc, `${safeFileName}.doc`, "application/msword");
                } 
                // C. PDF Print View with Formatted Tables
                // C. PDF Print View with Formatted Tables
                else if (format === "pdf") {
                    let pdfBody = "";
                    messages.forEach((m) => {
                        const isUser = m.role === "user";
                        pdfBody += `
                            <div class="bubble ${isUser ? 'user' : 'assistant'}">
                                <div class="sender">${isUser ? 'You' : 'AI Assistant'}</div>
                                <div class="msg-text">${parseMarkdownToHtml(m.content)}</div>
                            </div>`;
                    });

                    const pdfHtml = `
                        <!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
                        <style>
                            @page { margin: 12mm 15mm; size: auto; }
                            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; padding: 10px; color: #151515; }
                            h1 { color: #8b263e; font-size: 20px; border-bottom: 2px solid #8b263e; padding-bottom: 4px; margin-bottom: 4px; }
                            .meta { color: #777; font-size: 11px; margin-bottom: 16px; }
                            
                            /* Natural flow without forcing breaks */
                            .bubble { margin-bottom: 12px; padding: 10px 14px; border-radius: 4px; }
                            .bubble.user { background: #fdf5f7; border-left: 4px solid #8b263e; }
                            .bubble.assistant { background: #f6f8f6; border-left: 4px solid #2e7d32; }
                            .sender { font-size: 11px; font-weight: bold; text-transform: uppercase; margin-bottom: 6px; break-after: avoid; }
                            .bubble.user .sender { color: #8b263e; }
                            .bubble.assistant .sender { color: #2e7d32; }
                            .msg-text { font-size: 12.5px; line-height: 1.5; }
                            
                            /* Clean tables that wrap across pages by row */
                            table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 11.5px; }
                            th { background-color: #8b263e !important; color: #ffffff !important; padding: 7px 10px; border: 1px solid #6b1d30; text-align: left; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                            td { padding: 6px 10px; border: 1px solid #d5c0c6; text-align: left; }
                            tr { page-break-inside: avoid; }
                            tr:nth-child(even) td { background-color: #fcf8f9; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                        </style></head>
                        <body>
                            <h1>${title}</h1>
                            <div class="meta">Saved on: ${dateStr}</div>
                            ${pdfBody}
                            <script>
                                window.onload = () => { window.print(); setTimeout(() => window.close(), 500); };
                            <\/script>
                        </body></html>`;

                    const printWindow = window.open("", "_blank");
                    if (printWindow) {
                        printWindow.document.write(pdfHtml);
                        printWindow.document.close();
                    }
                }
                
                // Close dropdown
                const menu = document.getElementById(`export-menu-${convoId}`);
                if (menu) menu.classList.remove("show");

            } catch (err) {
                console.error("Export error:", err);
                alert("Failed to export conversation.");
            }
        });
    });
});