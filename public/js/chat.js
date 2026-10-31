document.addEventListener("DOMContentLoaded", () => {
    const askForm = document.getElementById("askForm");
    const qnInput = document.getElementById("qnInput");
    const submitBtn = document.getElementById("submitBtn");
    const resultBox = document.getElementById("resultBox");
    const displayQuestion = document.getElementById("displayQuestion");
    const displayAnswer = document.getElementById("displayAnswer");
    const clearBtn = document.getElementById("clearBtn");
    const stopBtn = document.getElementById("stopBtn");
    const levelSelect = document.getElementById("levelSelect");
    const chatScrollArea = document.getElementById("chatScrollArea");

    // Level selector dropdown elements
    const levelTriggerBtn = document.getElementById("levelTriggerBtn");
    const levelDropdownMenu = document.getElementById("levelDropdownMenu");
    const levelBadgeText = document.getElementById("levelBadgeText");
    const levelOptions = document.querySelectorAll(".level-option");
    const levelBadgeContainer = document.querySelector(".level-badge-container");

    const mdClient = window.markdownit ? window.markdownit({ html: false, breaks: true, linkify: true }) : null;

    const convoElem = document.getElementById("convoData");
    const rawConvoId = convoElem ? convoElem.getAttribute("data-convo-id") : null;
    let currentConvoId = rawConvoId ? parseInt(rawConvoId, 10) : null;

    let currentAbortController = null;
    let inactivityTimer = null;

    // Helper: Dynamically prepend new chat to sidebar without refreshing
    function addConversationToSidebar(convoId, titleText) {
        const list = document.querySelector(".sidebar-chat-list");
        if (!list) return;

        const emptyMsg = list.querySelector(".sidebar-empty-msg");
        if (emptyMsg) emptyMsg.remove();

        const existing = list.querySelector(`a[href*="convo_id=${convoId}"]`);
        if (existing) return;

        list.querySelectorAll(".sidebar-chat-item").forEach((el) => el.classList.remove("active"));

        const li = document.createElement("li");
        li.className = "sidebar-chat-item active";
        li.innerHTML = `
            <a href="/ask?convo_id=${convoId}" class="sidebar-chat-link" title="${titleText}">
                💬 ${titleText}
            </a>
        `;
        list.prepend(li);

        window.history.pushState({}, "", `/ask?convo_id=${convoId}`);
        if (convoElem) {
            convoElem.setAttribute("data-convo-id", convoId);
        }
    }

    // Level Dropdown toggle
    if (levelTriggerBtn && levelDropdownMenu) {
        levelTriggerBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            levelDropdownMenu.classList.toggle("show");
        });
    }

    levelOptions.forEach((option) => {
        option.addEventListener("click", (e) => {
            e.stopPropagation();
            levelSelect.value = option.getAttribute("data-value");
            if (levelBadgeText) {
                levelBadgeText.textContent = option.getAttribute("data-badge");
            }
            levelOptions.forEach((opt) => opt.classList.remove("active"));
            option.classList.add("active");
            levelDropdownMenu.classList.remove("show");
        });
    });

    document.addEventListener("click", (e) => {
        if (levelDropdownMenu && levelBadgeContainer && !levelBadgeContainer.contains(e.target)) {
            levelDropdownMenu.classList.remove("show");
        }
    });

    if (stopBtn) {
        stopBtn.addEventListener("click", () => {
            if (currentAbortController) {
                currentAbortController.abort("USER_CANCELLED");
                clearTimeout(inactivityTimer);
            }
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener("click", () => {
            currentConvoId = null;
            if (convoElem) convoElem.setAttribute("data-convo-id", "");
            qnInput.value = "";
            displayQuestion.textContent = "";
            displayAnswer.innerHTML = "";
            resultBox.classList.remove("visible");
            resultBox.style.display = "none";
            qnInput.focus();
        });
    }

    // Submit handler
    if (askForm) {
        askForm.addEventListener("submit", async (e) => {
            e.preventDefault();

            const question = qnInput.value.trim();
            const level = levelSelect ? levelSelect.value : "medium";
            if (!question) return;

            // Make stream box visible
            resultBox.classList.add("visible");
            resultBox.style.display = "block";
            displayQuestion.textContent = "Question: " + question;
            displayAnswer.innerHTML = '<span class="cursor-blink">▌</span>';

            if (chatScrollArea) {
                chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
            }

            submitBtn.disabled = true;
            if (stopBtn) stopBtn.style.display = "inline-block";

            currentAbortController = new AbortController();

            clearTimeout(inactivityTimer);
            inactivityTimer = setTimeout(() => {
                if (currentAbortController) currentAbortController.abort("INITIAL_TIMEOUT");
            }, 120000);

            try {
                const response = await fetch("/ask", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "text/event-stream"
                    },
                    body: JSON.stringify({
                        qnsent: question,
                        level: level,
                        convo_id: currentConvoId
                    }),
                    signal: currentAbortController.signal
                });

                if (!response.ok) {
                    clearTimeout(inactivityTimer);
                    const data = await response.json();
                    displayAnswer.innerHTML = `<p class="status-error" style="color: #ff6b6b;">${data.error || "Failed to fetch response."}</p>`;
                    return;
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let accumulatedRawText = "";

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;

                    if (inactivityTimer) {
                        clearTimeout(inactivityTimer);
                        inactivityTimer = null;
                    }

                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split("\n\n");

                    for (const line of lines) {
                        if (line.startsWith("data: ")) {
                            const jsonStr = line.replace("data: ", "").trim();
                            if (!jsonStr || jsonStr === "[DONE]") continue;

                            try {
                                const parsed = JSON.parse(jsonStr);

                                // If new chat started, update sidebar in real-time
                                if (parsed.convo_id) {
                                    if (!currentConvoId || currentConvoId !== parsed.convo_id) {
                                        addConversationToSidebar(parsed.convo_id, question.slice(0, 30));
                                    }
                                    currentConvoId = parsed.convo_id;
                                }

                                if (parsed.error) {
                                    displayAnswer.innerHTML = `<p class="status-error" style="color: #ff6b6b;">${parsed.error}</p>`;
                                    break;
                                }

                                if (parsed.token) {
                                    accumulatedRawText += parsed.token;
                                    displayAnswer.innerHTML = (mdClient ? mdClient.render(accumulatedRawText) : accumulatedRawText) + '<span class="cursor-blink">▌</span>';
                                    if (chatScrollArea) {
                                        chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
                                    }
                                }

                                if (parsed.done && mdClient) {
                                    displayAnswer.innerHTML = mdClient.render(accumulatedRawText);
                                }
                            } catch {
                                accumulatedRawText += jsonStr;
                                if (mdClient) {
                                    displayAnswer.innerHTML = mdClient.render(accumulatedRawText);
                                }
                            }
                        }
                    }
                }

                qnInput.value = "";
            } catch (err) {
                if (err.name === "AbortError") {
                    displayAnswer.innerHTML += '<p style="color: #7f8c8d;"><br><em>[Stream stopped by user]</em></p>';
                } else {
                    displayAnswer.innerHTML = '<p class="status-error" style="color: #ff6b6b;">Failed to fetch answer.</p>';
                }
            } finally {
                clearTimeout(inactivityTimer);
                inactivityTimer = null;
                submitBtn.disabled = false;
                if (stopBtn) stopBtn.style.display = "none";
                currentAbortController = null;
            }
        });
    }
});

// ❌ DELETE AN INDIVIDUAL MESSAGE AND REMOVE ITS BUBBLE
async function deleteMessage(msgId) {
    if (!confirm("Are you sure you want to delete this message?")) return;

    try {
        const response = await fetch(`/delete-message/${msgId}`, {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json"
            }
        });

        const data = await response.json();
        if (data.success) {
            const bubble = document.getElementById(`msg-bubble-${msgId}`);
            if (bubble) {
                bubble.style.transition = "opacity 0.2s ease, transform 0.2s ease";
                bubble.style.opacity = "0";
                bubble.style.transform = "scale(0.95)";
                setTimeout(() => bubble.remove(), 200);
            }
        } else {
            alert("Could not delete message.");
        }
    } catch (err) {
        console.error("Error deleting message:", err);
    }
}