import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

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
				dlg.style.display = "flex";
				return;
			}

			// Overlay
			dlg = document.createElement("div");
			dlg.id = "backup-hf-dialog";
			Object.assign(dlg.style, {
				position: "fixed",
				top: 0,
				left: 0,
				width: "100vw",
				height: "100vh",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "rgba(0,0,0,0.5)",
				zIndex: 9999,
			});
			// Click outside panel to close
			dlg.addEventListener("click", (e) => {
				if (e.target === dlg) dlg.style.display = "none";
			});

			// Panel
			const panel = document.createElement("div");
			Object.assign(panel.style, {
				background: "#17191f",
				color: "#fff",
				padding: "40px",
				borderRadius: "12px",
				minWidth: "640px",
				maxWidth: "80vw",
				display: "flex",
				flexDirection: "column",
				gap: "20px",
				boxShadow: "0 0 20px rgba(0,0,0,0.7)",
				border: "1px solid #3c3c3c",
			});

			 // Heading text
			const heading = document.createElement("div");
			heading.textContent = "Enter list of folders to upload to Hugging Face.\nNewer versions will overwrite older ones.";
			Object.assign(heading.style, {
				marginBottom: "10px",
				color: "#fff",
				fontSize: "14px",
				whiteSpace: "pre-line",
			});
			panel.appendChild(heading);

			// Multiline input
			const ta = document.createElement("textarea");
			ta.rows = 8;
			ta.placeholder = "Enter folders to backup, one per line...";
			ta.value = `custom_nodes/ #Custom nodes folder
user/ #User settings and workflows folder
models/loras 
models/upscale_models
models/controlnet
models/checkpoints #Below the size limit`; // Default content
			Object.assign(ta.style, {
				width: "100%",
				resize: "vertical",
				padding: "12px",
				borderRadius: "8px",
				background: "#1f2128",
				border: "1px solid #3c3c3c",
				color: "#fff",
				fontSize: "14px",
				fontFamily: "monospace",
				minHeight: "180px",
			});

			// Buttons
			const btnRow = document.createElement("div");
			Object.assign(btnRow.style, {
				display: "flex",
				justifyContent: "space-between", // Adjusted for grouped buttons
				gap: "8px",
			});

			// Cancel button
			const cancelButton = document.createElement("button");
			cancelButton.textContent = "Cancel";
			cancelButton.className = "p-button p-component p-button-secondary"; // PrimeVue styling
			cancelButton.onclick = () => {
				dlg.style.display = "none";
			};
			btnRow.appendChild(cancelButton);

			// Grouped buttons (Upload and Restore)
			const actionGroup = document.createElement("div");
			Object.assign(actionGroup.style, {
				display: "flex",
				gap: "8px",
			});

			 // Restore button (moved up)
			const restoreButton = document.createElement("button");
			restoreButton.textContent = "Download";
			restoreButton.className = "p-button p-component"; // Removed p-button-info
			restoreButton.onclick = async () => {
				try {
					setBackupState(true);
					const resp = await fetch("/restore_from_hf", {
						method: "POST",
						headers: { "Content-Type": "application/json" }
					});
					const result = await resp.json();
					if (result.status === "ok") {
						const restartDlg = document.createElement("div");
						Object.assign(restartDlg.style, {
							position: "fixed",
							top: 0,
							left: 0,
							width: "100vw",
							height: "100vh",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							background: "rgba(0,0,0,0.5)",
							zIndex: 10000,
						});

						const restartPanel = document.createElement("div");
						Object.assign(restartPanel.style, {
							background: "#17191f",
							color: "#fff",
							padding: "40px",
							borderRadius: "12px",
							minWidth: "400px",
							display: "flex",
							flexDirection: "column",
							gap: "20px",
							boxShadow: "0 0 20px rgba(0,0,0,0.7)",
							border: "1px solid #3c3c3c",
						});

						const message = document.createElement("div");
						message.textContent = "Restore completed successfully! You need to restart ComfyUI for the custom nodes changes to take effect.";
						Object.assign(message.style, {
							marginBottom: "20px",
							textAlign: "center"
						});
						restartPanel.appendChild(message);

						const btnContainer = document.createElement("div");
						Object.assign(btnContainer.style, {
							display: "flex",
							justifyContent: "center",
							gap: "10px"
						});

						const restartBtn = document.createElement("button");
						restartBtn.textContent = "Restart Now";
						restartBtn.className = "p-button p-component p-button-success";
						restartBtn.onclick = async () => {
							// Call restart endpoint - you'll need to implement this in your server
							try {
								await fetch("/restart", { method: "POST" });
							} catch (e) {
								console.error("Failed to restart:", e);
								// Even if the fetch fails, we'll reload as a fallback
							}
							// Force reload the page after a short delay
							setTimeout(() => window.location.reload(), 1000);
						};
						btnContainer.appendChild(restartBtn);

						const laterBtn = document.createElement("button");
						laterBtn.textContent = "Restart Later";
						laterBtn.className = "p-button p-component p-button-secondary";
						laterBtn.onclick = () => {
							restartDlg.remove();
						};
						btnContainer.appendChild(laterBtn);

						restartPanel.appendChild(btnContainer);
						restartDlg.appendChild(restartPanel);
						document.body.appendChild(restartDlg);
					} else {
						alert("Restore failed: " + result.message);
					}
				} catch (err) {
					alert("Restore error: " + err);
				} finally {
					setBackupState(false);
					dlg.style.display = "none";
				}
			};
			actionGroup.appendChild(restoreButton);

			// Upload button (moved down)
			const uploadButton = document.createElement("button");
			uploadButton.textContent = "Backup";
			uploadButton.className = "p-button p-component p-button-success";
			
			const setBackupState = (isBackingUp) => {
				panel.style.opacity = isBackingUp ? "0.7" : "1";
				ta.disabled = isBackingUp;
				uploadButton.textContent = isBackingUp ? "Cancel" : "Backup";
				uploadButton.className = isBackingUp 
					? "p-button p-component p-button-danger"
					: "p-button p-component p-button-success";
				cancelButton.disabled = isBackingUp;
				restoreButton.disabled = isBackingUp;
			};

			uploadButton.onclick = async () => {
				if (uploadButton.textContent === "Cancel") {
					dlg.style.display = "none";
					return;
				}

				const folders = ta.value
					.split("\n")
					.map(line => line.split("#")[0].trim())
					.filter(line => !!line);
				const sizeLimit = 5;

				try {
					setBackupState(true);
					const resp = await fetch("/backup_to_hf", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ 
							folders, 
							size_limit_gb: sizeLimit,
						})
					});
					const result = await resp.json();
					if (result.status === "ok") {
						alert("Backup completed successfully!");
					} else {
						alert("Backup failed: " + result.message);
					}
				} catch (err) {
					alert("Backup error: " + err);
				} finally {
					setBackupState(false);
					dlg.style.display = "none";
				}
			};

			actionGroup.appendChild(uploadButton);

			btnRow.appendChild(actionGroup);

			panel.appendChild(ta);
			panel.appendChild(btnRow);
			dlg.appendChild(panel);
			document.body.appendChild(dlg);
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