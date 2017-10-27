﻿var express = require("express"),
    fs = require("fs"),
    path = require("path"),
    querystring = require('querystring'),
    passport = require("passport"),
    localStrategy = require("passport-local").Strategy,
    svgCaptcha = require("svg-captcha"),
    middleware = require("./middleware.js"),
    formatting = require("./formatting.js");

var config, database, sitePages;

var restrictedRoute = middleware.restrictedRoute;
var urlencodedParser = middleware.bodyParser;
var server = express.Router();

passport.use("local", new localStrategy({ usernameField: "username", passwordField: "password" }, function (username, password, cb) {
    database.userByName(username, function (err, user) {
        if (err) { return cb(err); }
        if (!user) { return cb(null, false); }
        // wtf
        if (user.Password != formatting.sha256(password + (user.Salt || ""))) { return cb(null, false); }
        return cb(null, user);
    });
}));
passport.serializeUser(function (user, cb) {
    // UInt8Arrays don't take to the DB well, so mangle first
    cb(null, user.UserID.toString("hex"));
});
passport.deserializeUser(function (id, cb) {
    database.userById(formatting.hexToBin(id), function (err, user) {
        if (err) { return cb(err); }
        cb(null, user);
    });
});

server.use(passport.initialize());
server.use(passport.session());
// HACK: Copied here until passport is moved back to main router
server.use(function (req, res, next) {
    res.locals.user = req.user;
    next();
});

// Auth routes
server.get("/user/login", function (req, res) {
    if (req.user) {
        return res.redirect(req.get("Referrer") || "/home");
    } else {
        return res.render("login", {
            message: null
        });
    }
});

server.post("/user/login", urlencodedParser, function (req, res) {
    passport.authenticate("local", function (err, user, info) {
        if (err) {
            console.log(err);
            return res.status(500).render("error", {
                message: "There was an error authenticating."
            });
        }
        // if user is not found due to wrong username or password
        if (!user) {
            return res.status(400).render("login", {
                message: "Invalid username or password."
            });
        }
        if (user.AccountEnabled == "False") {
            return res.status(400).render("login", {
                message: "Your account has been disabled."
            });
        }
        //passport.js has a logIn user method
        req.logIn(user, function (err) {
            if (err) {
                console.log(err);
                return res.status(500).render("error", {
                    message: "There was an error authenticating."
                });
            }

            // Update LastSeenTime
            var id = formatting.hexToBin(user.UserID.toString("hex"));
            database.execute("UPDATE Users SET LastSeenTime = NOW() WHERE UserId = ?", [id], function (lsErr, lsRes, lsFields) {
                // we can wait this one out
            });

            // The user has an insecure password and should change it.
            if (user.Salt) {
                return res.redirect("/home");
            } else {
                return res.render("error", {
                    message: "Your password was stored in an insecure way - you need to <a href='/user/edit'>update it</a>."
                });
            }
        });
    })(req, res);
});

server.get("/user/logout", function (req, res) {
    req.logout();
    return res.redirect("/home");
});

// TODO: Refactor these routes for admins to edit other profiles
// They could use SQL for now, but as we extend, that's infeasible
server.get("/user/edit", restrictedRoute(), function (req, res) {
    return res.render("editProfile", {
        message: null,
        messageColour: null,
    });
});

server.post("/user/changepw", restrictedRoute(), urlencodedParser, function (req, res) {
    if (req.body && req.body.password && req.body.newPassword && req.body.newPasswordR) {
        if (formatting.sha256(req.body.password + (req.user.Salt || "")) == req.user.Password) {
            if (req.body.newPassword == req.body.newPasswordR) {
                var salt = formatting.createSalt();
                var newPassword = formatting.sha256(req.body.newPassword + salt);
                // HACK: nasty way to demangle UInt8Array
                var id = formatting.hexToBin(req.user.UserID.toString("hex"));
                database.execute("UPDATE Users SET Password = ?, Salt = ? WHERE UserID = ?", [newPassword, salt, id], function (pwErr, pwRes, pwFields) {
                    if (pwErr) {
                        return res.status(500).render("editProfile", {
                            message: "There was an error changing your password.",
                            messageColour: "alert-danger",
                        });
                    } else {
                        return res.render("editProfile", {
                            message: "Your password change was a success!",
                            messageColour: "alert-success",
                        });
                    }
                });
            } else {
                return res.status(400).render("editProfile", {
                    message: "The new passwords don't match.",
                    messageColour: "alert-danger",
                });
            }
        } else {
            return res.status(403).render("editProfile", {
                message: "The current password given was incorrect.",
                messageColour: "alert-danger",
            });
        }
    } else {
        return res.status(400).render("editProfile", {
            message: "The request was malformed.",
            messageColour: "alert-danger",
        });
    }
});

server.post("/user/edit", restrictedRoute(), urlencodedParser, function (req, res) {
    // TODO: Extend as we extend editable profile options (none for now)
    if (req.body && req.body.email) {
        // HACK: nasty way to demangle UInt8Array
        var id = formatting.hexToBin(req.user.UserID.toString("hex"));
        database.execute("UPDATE Users SET Email = ? WHERE UserID = ?", [req.body.email, id], function (pwErr, pwRes, pwFields) {
            if (pwErr) {
                return res.render("editProfile", {
                    message: "There was an error changing your profile.",
                    messageColour: "alert-danger",
                });
            } else {
                return res.render("editProfile", {
                    message: "Your profile change was a success!",
                    messageColour: "alert-success",
                });
            }
        });
    } else {
        return res.status(400).render("editProfile", {
            message: "The request was malformed.",
            messageColour: "alert-danger",
        });
    }
});

function signupPage(req, res, status, message) {
    var captcha = svgCaptcha.create({ size: 6, noise: 2 });
    req.session.captcha = captcha;

    return res.status(status || 200).render("signup", {
        message: message,
        captcha: captcha.data,
    });
}

server.get("/user/signup", function (req, res) {
    return signupPage(req, res, null, null);
});

server.post("/user/signup", urlencodedParser, function (req, res) {
    if (req.body && req.body.username && req.body.password && req.body.captcha && req.body.email) {
        if (/^[A-Za-z0-9-_ ]{4,32}$/.test(req.body.username) == false) {
            return signupPage(req, res, 400, "The username is invalid.");
        }
        if (req.body.captcha == req.session.captcha.text) {
            // check for username existence
            database.execute("SELECT * FROM `Users` WHERE `ShortName` = ? OR `Email` = ?", [req.body.username, req.body.email], function (slErr, slRes, slFields) {
                if (slErr) {
                    return signupPage(req, res, 500, "There was an error checking the database.");
                } else if (slRes.length > 0) {
                    return signupPage(req, res, 400, "There is already a user with that name or email address.");
                } else {
                    var salt = formatting.createSalt();
                    var password = formatting.sha256(req.body.password + salt);
                    database.execute("INSERT INTO `Users` (`ShortName`, `Email`, `Password`, `Salt`, `RegistrationIP`) VALUES (?, ?, ?, ?, ?)", [req.body.username, req.body.email, password, salt, req.ip], function (inErr, inRes, inFields) {
                        if (inErr) {
                            return signupPage(req, res, 500, "There was an error creating your account.");
                        } else {
                            res.redirect("/user/login");
                        }
                    });
                }
            });
        } else {
            return signupPage(req, res, 400, "The captcha failed verification.");
        }
    } else {
        return signupPage(req, res, 400, "The request was malformed.");
    }
});

server.get("/user/vanillaSSO", function (req, res) {
    if (req.query.client_id != config.vanillaClientId) {
        return res.send(req.query.callback + "(" + JSON.stringify({
            error: "invalid_client",
            message: "Client ID does not match.",
        }) + ")");
    }

    if (req.query.timestamp && formatting.sha256(req.query.timestamp + config.vanillaSecret) != req.query.signature) {
        return res.send(req.query.callback + "(" + JSON.stringify({
            error: "invalid_signature",
            message: "Signature does not match.",
        }) + ")");
    }

    var builtObject;

    if (req.user) {
        // built pre-sorted array
        builtObject = {
            email: req.user.Email,
            name: req.user.ShortName,
            roles: "member",
            uniqueid: formatting.binToHex(req.user.UserID),
        };
        if (req.user.UserFlags.some(function (x) { return x.FlagName == "sa"; })) {
            builtObject.roles = "member,administrator";
        }
        // for crypto's sake
        var qs = querystring.stringify(builtObject);
        // append items that dont need to be signed/sorted
        builtObject.client_id = req.query.client_id;
        builtObject.signature = formatting.sha256(qs + config.vanillaSecret);
    } else {
        builtObject = {
            name: ""
        };
    }
    console.log(JSON.stringify(builtObject));
    res.send(req.query.callback + "(" + JSON.stringify(builtObject) + ")");
});

module.exports = function (c, d, p) {
    config = c
    database = d;
    sitePages = p;
    
    // init user flags once we're connected
    database.execute("SELECT * FROM `UserFlags`", [], function (ufErr, ufRes, ufFields) {
        // first, init userFlags
        database.userFlags = ufRes;
    });

    return server;
}