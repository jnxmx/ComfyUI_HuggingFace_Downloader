const text = "The repository 'repo' is gated or you do not have permission to access it.\nVisit https://huggingface.co/repo, accept its terms or request access, then retry the download.";
const urlRegex = /(https?:\/\/[^\s]+)/g;
const parts = text.split(urlRegex);
console.log("parts:", parts);
for (const part of parts) {
    console.log("testing:", part, "result:", urlRegex.test(part), "lastIndex:", urlRegex.lastIndex);
}
