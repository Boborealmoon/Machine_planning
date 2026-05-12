// Navbar dropdowns
document.querySelectorAll(".nav-dropdown-trigger").forEach((trigger) => {
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = trigger.dataset.dropdown;
    const menu = document.getElementById("dd-" + id);
    const isOpen = menu.classList.contains("open");

    // Close all
    document.querySelectorAll(".nav-dropdown-menu").forEach((m) =>
      m.classList.remove("open")
    );

    if (!isOpen) menu.classList.add("open");
  });
});

document.addEventListener("click", () => {
  document.querySelectorAll(".nav-dropdown-menu").forEach((m) =>
    m.classList.remove("open")
  );
});
