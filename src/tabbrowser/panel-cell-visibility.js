function shouldAttachPanelCell(panelVisible, cellVisible) {
  return !!panelVisible && cellVisible !== false;
}

module.exports = { shouldAttachPanelCell };
