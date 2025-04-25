import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

app.registerExtension({
	name: "backupToHuggingFace",
	setup() {
		/* ──────────────── Helper Functions ──────────────── */
		const getFolderStructure = async () => {
			// Get model folders list
			const resp = await fetch("/folder_structure", {
				method: "GET"
			});
			if (!resp.ok) return [];
			const data = await resp.json();
			return data;
		};

		const createCheckbox = (id, label, checked = false) => {
			const container = document.createElement("div");
			Object.assign(container.style, {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "4px 0"
			});

			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.id = id;
			checkbox.checked = checked;

			const labelEl = document.createElement("label");
			labelEl.htmlFor = id;
			labelEl.textContent = label;
			Object.assign(labelEl.style, {
				color: "#fff",
				fontSize: "14px"
			});

			container.appendChild(checkbox);
			container.appendChild(labelEl);
			return container;
		};

		/* ──────────────── D I A L O G ──────────────── */
		const showBackupDialog = async () => {
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
			heading.textContent = "Select folders to backup to Hugging Face.\nNewer versions will overwrite older ones.";
			Object.assign(heading.style, {
				marginBottom: "10px",
				color: "#fff",
				fontSize: "14px",
				whiteSpace: "pre-line",
			});
			panel.appendChild(heading);

			 // Checkbox container with sections
			const checkboxContainer = document.createElement("div");
			Object.assign(checkboxContainer.style, {
				display: "flex",
				flexDirection: "column",
				gap: "16px",
				padding: "12px",
				background: "#1f2128",
				border: "1px solid #3c3c3c",
				borderRadius: "8px",
				maxHeight: "400px",
				overflowY: "auto"
			});

			// System folders section
			const systemSection = document.createElement("div");
			Object.assign(systemSection.style, {
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				borderBottom: "1px solid #3c3c3c",
				paddingBottom: "16px"
			});

			const systemTitle = document.createElement("div");
			systemTitle.textContent = "System Folders";
			Object.assign(systemTitle.style, {
				color: "#8c8c8c",
				fontSize: "12px",
				textTransform: "uppercase",
				marginBottom: "4px"
			});
			systemSection.appendChild(systemTitle);

			// Add system checkboxes
			systemSection.appendChild(createCheckbox("user", "User Settings and Workflows", true));
			systemSection.appendChild(createCheckbox("custom_nodes", "Custom Nodes", true));

			// In/Out folders section (initially unchecked)
			const ioSection = document.createElement("div");
			Object.assign(ioSection.style, {
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				borderBottom: "1px solid #3c3c3c",
				paddingBottom: "16px"
			});

			const ioTitle = document.createElement("div");
			ioTitle.textContent = "Data Folders";
			Object.assign(ioTitle.style, {
				color: "#8c8c8c",
				fontSize: "12px",
				textTransform: "uppercase",
				marginBottom: "4px"
			});
			ioSection.appendChild(ioTitle);

			ioSection.appendChild(createCheckbox("input", "Input Folder"));
			ioSection.appendChild(createCheckbox("output", "Output Folder"));

			// Models section
			const modelsSection = document.createElement("div");
			Object.assign(modelsSection.style, {
				display: "flex",
				flexDirection: "column",
				gap: "8px"
			});

			const modelsTitle = document.createElement("div");
			modelsTitle.textContent = "Model Folders";
			Object.assign(modelsTitle.style, {
				color: "#8c8c8c",
				fontSize: "12px",
				textTransform: "uppercase",
				marginBottom: "4px"
			});
			modelsSection.appendChild(modelsTitle);

			// Get model folders and add checkboxes
			const modelFolders = await getFolderStructure();
			for (const folder of modelFolders) {
				modelsSection.appendChild(createCheckbox(
					`models/${folder}`,
					folder,
					// Default checked for common model folders
					["loras", "controlnet", "checkpoints"].includes(folder)
				));
			}

			checkboxContainer.appendChild(systemSection);
			checkboxContainer.appendChild(ioSection);
			checkboxContainer.appendChild(modelsSection);

			// Buttons row
			const btnRow = document.createElement("div");
			Object.assign(btnRow.style, {
				display: "flex",
				justifyContent: "space-between",
				gap: "8px",
			});

			// Cancel button
			const cancelButton = document.createElement("button");
			cancelButton.textContent = "Cancel";
			cancelButton.className = "p-button p-component p-button-secondary";
			cancelButton.onclick = () => {
				dlg.style.display = "none";
			};
			btnRow.appendChild(cancelButton);

			// Action buttons group
			const actionGroup = document.createElement("div");
			Object.assign(actionGroup.style, {
				display: "flex",
				gap: "8px",
			});

			// Restore button 
			const restoreButton = document.createElement("button");
			restoreButton.textContent = "Download";
			restoreButton.className = "p-button p-component";

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

			// Upload button
			const uploadButton = document.createElement("button");
			uploadButton.textContent = "Backup";
			uploadButton.className = "p-button p-component p-button-success";
			
			const setBackupState = (isBackingUp) => {
				panel.style.opacity = isBackingUp ? "0.7" : "1";
				checkboxContainer.querySelectorAll("input").forEach(cb => cb.disabled = isBackingUp);
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

				// Get checked folders
				const folders = Array.from(checkboxContainer.querySelectorAll("input[type=checkbox]"))
					.filter(cb => cb.checked)
					.map(cb => cb.id);

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

			panel.appendChild(checkboxContainer);
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