import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { createApp, h } from "vue";
import PrimeVue from "primevue/config";
import Dialog from "primevue/dialog";
import Textarea from "primevue/textarea";
import Button from "primevue/button";

/**
 * Minimal scaffold + “Backup ComfyUI to Hugging Face” dialog.
 * Flesh the guts out later: actual backup logic, HF auth, etc.
 */
app.registerExtension({
	name: "backupToHuggingFace", // Renamed extension
	setup() {

		/* ──────────────── D I A L O G ──────────────── */
		const showBackupDialog = () => {
			// Keep just one instance alive
			let dlg = document.getElementById("backup-hf-dialog");
			if (dlg) {
				dlg.__vue_app__.config.globalProperties.visible = true;
				return;
			}

			// Create Vue app for the dialog
			const appContainer = document.createElement("div");
			appContainer.id = "backup-hf-dialog";
			document.body.appendChild(appContainer);

			const appInstance = createApp({
				data() {
					return {
						visible: true,
						backupContent: `custom_nodes/ #Custom nodes folder
user/ #User settings and workflows folder
models/loras 
models/checkpoints/ #Below the size limit`,
					};
				},
				methods: {
					handleBackup() {
						console.log("Backup upload clicked", this.backupContent);
						// TODO: call actual upload routine here
						this.visible = false;
					},
					handleRestore() {
						console.log("Backup restore clicked", this.backupContent);
						// TODO: call actual restore routine here
						this.visible = false;
					},
				},
				render() {
					return h(Dialog, {
						visible: this.visible,
						modal: true,
						style: { width: "500px" },
						"onUpdate:visible": (val) => (this.visible = val),
					}, {
						default: () => [
							h(Textarea, {
								modelValue: this.backupContent,
								"onUpdate:modelValue": (val) => (this.backupContent = val),
								rows: 5,
								autoResize: true,
								style: { width: "100%" },
							}),
							h("div", {
								style: {
									display: "flex",
									justifyContent: "space-between",
									marginTop: "16px",
								},
							}, [
								h(Button, {
									label: "Cancel",
									class: "p-button-secondary",
									onClick: () => (this.visible = false),
								}),
								h("div", {
									style: { display: "flex", gap: "8px" },
								}, [
									h(Button, {
										label: "Backup",
										class: "p-button-success",
										onClick: this.handleBackup,
									}),
									h(Button, {
										label: "Download",
										class: "p-button-info",
										onClick: this.handleRestore,
									}),
								]),
							]),
						],
					});
				},
			});

			appInstance.use(PrimeVue);
			appInstance.component("Dialog", Dialog);
			appInstance.component("Textarea", Textarea);
			appInstance.component("Button", Button);
			appInstance.mount(appContainer);
		};

		/* ─────────── Canvas-menu injection ─────────── */
		const origMenu = LGraphCanvas.prototype.getCanvasMenuOptions;
		LGraphCanvas.prototype.getCanvasMenuOptions = function () {
			const menu = origMenu.apply(this, arguments);

			menu.push(null, {
				content: "Backup ComfyUI to Hugging Face",
				callback: showBackupDialog,
			});

			return menu;
		};

		/* (Any other graph events you need) */
		// api.addEventListener("executing", ({ detail }) => { ... });
	},
});