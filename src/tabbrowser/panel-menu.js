function createPanelMenuTemplate(openPanel) {
  return [
    {
      label: "面板",
      click: () => openPanel("blank"),
    },
    {
      label: "Telegram 矩阵",
      click: () => openPanel("telegram-matrix"),
    },
    {
      label: "Redroid 矩阵",
      click: () => openPanel("redroid-matrix"),
    },
  ];
}

module.exports = { createPanelMenuTemplate };
