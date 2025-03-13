import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "HF Downloader",
    async setup() {
        const nodeTypes = ["Hugging Face Download Model", "Hugging Face Download Folder"];
        
        nodeTypes.forEach(nodeType => {
            const fullType = "Hugging Face Downloaders/" + nodeType;
            const origNode = LiteGraph.registered_node_types[fullType];
            if (!origNode) {
                console.error(`Original node not found: ${fullType}`);
                return;
            }
            
            origNode.prototype.onDrawTitleBar = function(ctx, title_height, size, collapsed) {
                if (this.progress !== undefined) {
                    const progress = Math.min(100, Math.max(0, this.progress));
                    const width = (size[0] * progress) / 100;
                    ctx.save();
                    ctx.fillStyle = "#2080ff44";
                    const radius = 4;
                    ctx.beginPath();
                    ctx.roundRect(0, 0, width, title_height, [radius, radius, 0, 0]);
                    ctx.fill();
                    ctx.restore();
                }
                if (!collapsed) {
                    ctx.fillStyle = "#fff";
                    ctx.font = LiteGraph.NODE_TEXT_SIZE + "px Arial";
                    ctx.textAlign = "left";
                    ctx.fillText(this.title, 4, title_height * 0.7);
                }
            };
            
            origNode.prototype.setProgress = function(progress) {
                this.progress = progress;
                this.setDirtyCanvas(true);
            };
        });
        
        api.addEventListener("huggingface.download.progress", (event) => {
            const progress = event.detail.progress;
            app.graph.nodes.forEach((node) => {
                if (node.comfyClass === "Hugging Face Download Model" || node.comfyClass === "Hugging Face Download Folder") {
                    node.setProgress(progress);
                }
            });
        });
        
        api.addEventListener("huggingface.download.complete", (event) => {
            const message = event.detail.message;
            app.graph.nodes.forEach((node) => {
                if (node.comfyClass === "Hugging Face Download Model" || node.comfyClass === "Hugging Face Download Folder") {
                    node.setProgress(100);
                }
            });
            console.log("Download complete:", message);
        });
    }
});
