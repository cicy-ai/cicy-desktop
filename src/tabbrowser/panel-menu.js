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
  ];
}

module.exports = { createPanelMenuTemplate };
