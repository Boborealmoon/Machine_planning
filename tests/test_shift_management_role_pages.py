from app import app


def test_role_homes_and_forbidden_pages():
    app.config["TESTING"] = True
    c = app.test_client()

    cases = {
        "op1": {
            "home": "/Shift-management/jobs",
            "ok": ("/jobs", "/tickets"),
            "blocked": ("/dashboard", "/ops", "/history", "/hoto"),
        },
        "qc1": {
            "home": "/Shift-management/jobs",
            "ok": ("/jobs", "/tickets"),
            "blocked": ("/dashboard", "/ops", "/history", "/hoto"),
        },
        "sup1": {
            "home": "/Shift-management/ops",
            "ok": ("/ops", "/tickets", "/history", "/hoto"),
            "blocked": ("/dashboard", "/jobs", "/backlog"),
        },
        "adm1": {
            "home": "/Shift-management/dashboard",
            "ok": ("/dashboard", "/ops", "/history", "/hoto", "/backlog"),
            "blocked": ("/jobs", "/tickets"),
        },
    }

    for user, spec in cases.items():
        c.get("/shift-management-logout")
        login = c.post(
            "/shift-management-login",
            data={"username": user, "password": "1234"},
            follow_redirects=False,
        )
        assert login.status_code == 302, user
        home = c.get("/Shift-management", follow_redirects=False)
        assert home.status_code == 302
        assert home.headers["Location"].endswith(spec["home"].split("/Shift-management", 1)[-1]) or (
            spec["home"] in home.headers["Location"]
        )
        for path in spec["ok"]:
            res = c.get("/Shift-management" + path, follow_redirects=False)
            assert res.status_code == 200, (user, path, res.status_code)
        for path in spec["blocked"]:
            res = c.get("/Shift-management" + path, follow_redirects=False)
            assert res.status_code == 302, (user, path, res.status_code)
            assert path not in (res.headers.get("Location") or "")

    c.get("/shift-management-logout")
    login = c.post(
        "/shift-management-login",
        data={"username": "sup1", "password": "1234"},
        follow_redirects=False,
    )
    assert login.status_code == 302
    tickets = c.get("/Shift-management/tickets", follow_redirects=False)
    assert tickets.status_code == 200
    page = tickets.get_data(as_text=True)
    assert "sm-tickets-sort" in page
    assert "who raised each ticket" in page
