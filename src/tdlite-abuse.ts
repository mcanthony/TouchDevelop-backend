/// <reference path='../typings/node/node.d.ts' />

'use strict';

import * as td from './td';
import * as assert from 'assert';

type JsonObject = td.JsonObject;
type JsonBuilder = td.JsonBuilder;


import * as parallel from "./parallel"
import * as indexedStore from "./indexed-store"
import * as core from "./tdlite-core"
import * as tdliteWorkspace from "./tdlite-workspace"
import * as audit from "./tdlite-audit"
import * as notifications from "./tdlite-notifications"
import * as tdliteReviews from "./tdlite-reviews"
import * as tdliteUsers from "./tdlite-users"
import * as tdliteComments from "./tdlite-comments"

var withDefault = core.withDefault;
var orEmpty = td.orEmpty;

var logger = core.logger;
var httpCode = core.httpCode;
var abuseReports: indexedStore.Store;

var wordRecognizer: {};  
var scannerRegexes: td.SMap<RegExp>;

export class PubAbusereport
    extends td.JsonRecord
{
    @td.json public kind: string = "";
    @td.json public time: number = 0;
    @td.json public id: string = "";
    @td.json public text: string = "";
    @td.json public userid: string = "";
    @td.json public username: string = "";
    @td.json public userscore: number = 0;
    @td.json public userhaspicture: boolean = false;
    @td.json public userplatform: string[];
    @td.json public publicationid: string = "";
    @td.json public publicationname: string = "";
    @td.json public publicationkind: string = "";
    @td.json public publicationuserid: string = "";
    @td.json public resolution: string = "";
    
    // admin-only
    @td.json public usernumreports = 0;
    @td.json public publicationnumabuses = 0;
    @td.json public publicationusernumabuses = 0;
    
    static createFromJson(o:JsonObject) { let r = new PubAbusereport(); r.fromJson(o); return r; }
}

export interface IPubAbusereport {
    kind: string;
    time: number;
    id: string;
    text: string;
    userid: string;
    username: string;
    userscore: number;
    userhaspicture: boolean;
    userplatform: string[];
    publicationid: string;
    publicationname: string;
    publicationkind: string;
    publicationuserid: string;
    resolution: string;
}

export class CandeleteResponse
    extends td.JsonRecord
{
    @td.json public publicationkind: string = "";
    @td.json public publicationname: string = "";
    @td.json public publicationuserid: string = "";
    @td.json public candeletekind: boolean = false;
    @td.json public candelete: boolean = false;
    @td.json public hasabusereports: boolean = false;
    @td.json public canmanage: boolean = false;
    static createFromJson(o:JsonObject) { let r = new CandeleteResponse(); r.fromJson(o); return r; }
}

export interface ICandeleteResponse {
    publicationkind: string;
    publicationname: string;
    publicationuserid: string;
    candeletekind: boolean;
    candelete: boolean;
    hasabusereports: boolean;
    canmanage: boolean;
}

export async function initAsync() : Promise<void>
{
    core.registerSettingsCleanup(() => {
        wordRecognizer = null;  
        scannerRegexes = null;        
    })
    
    abuseReports = await indexedStore.createStoreAsync(core.pubsContainer, "abusereport");
    await core.setResolveAsync(abuseReports, async (fetchResult: indexedStore.FetchResult, apiRequest: core.ApiRequest) => {
        let users = <core.IUser[]>await core.followPubIdsAsync(fetchResult.items, "publicationuserid", "");
        let pubs = await core.followPubIdsAsync(fetchResult.items, "publicationid", "");
        let withUsers = await core.addUsernameEtcCoreAsync(fetchResult.items);
        let coll = (<PubAbusereport[]>[]);
        let x = 0;
        for (let jsb of withUsers) {
            let isFacilitator = core.callerIsFacilitatorOf(apiRequest, users[x]) 
            if (isFacilitator ||
                jsb["pub"]["userid"] == apiRequest.userid || 
                core.callerIsFacilitatorOf(apiRequest, jsb["*userid"])) {
                let report = PubAbusereport.createFromJson(jsb["pub"]);
                report.text = core.decrypt(report.text);
                coll.push(report);
                
                if (isFacilitator) {
                    report.publicationnumabuses = pubs[x] ? pubs[x]["numAbuses"] || 0 : 0
                    report.publicationusernumabuses = users[x] ? users[x]["numAbusesByUser"] || 0 : 0
                    report.usernumreports = jsb["*userid"] ? jsb["*userid"]["numReports"] || 0 : 0
                }
            }
            x = x + 1;
        }
        fetchResult.items = td.arrayToJson(coll);
    }, {
        byUserid: true,
        byPublicationid: true
    });
    await abuseReports.createIndexAsync("publicationuserid", entry => entry["pub"]["publicationuserid"]);
    core.addRoute("GET", "*user", "abuses", async (req: core.ApiRequest) => {
        await core.anyListAsync(abuseReports, req, "publicationuserid", req.rootId);
    });
    
    core.addRoute("POST", "art", "reshield", async (req: core.ApiRequest) => {
        if (!core.checkPermission(req, "operator")) return;
        let store = indexedStore.storeByKind("art");
        let lst = await store.getIndex("all").fetchAsync("all", req.queryOptions);
        let resp = {
            continuation: lst.continuation,
            itemCount: lst.items.length,
            itemsReindexed: 0
        }
        await parallel.forJsonAsync(lst.items, async(e) => {
            if (e["arttype"] != "picture") return;
            
            let sh = e["shieldinfo"]
            if (sh) {
                if (sh["acssafe"] == "1" || sh["webpurifysafe"] == "1") {
                    // OK
                } else if (sh["acssafe"] == "0") {
                    resp.itemsReindexed++;
                    let jobid = sh["acsjobid"] || ""
                    await postAcsReport(e["id"], "Legacy ACS flag. " + jobid, jobid)                    
                } else {
                    sh = null;
                }
            }
            
            if (!sh) {
                // TODO rescan ...
            }            
        }, 20)
        req.response = resp;
    });

    core.addRoute("POST", "*abusereport", "", async (req: core.ApiRequest) => {
        let pub = req.rootPub["pub"];
        // any-facilitator is good enough to update any abuse report, even about users on higher level
        if (!core.hasPermission(req.userinfo.json, "any-facilitator"))
            await core.checkFacilitatorPermissionAsync(req, pub["publicationuserid"]);        
        if (req.status == 200) {
            let res = td.toString(req.body["resolution"]);
            if (res == "deleted") {
                req.status = httpCode._402PaymentRequired;
                return;
            }
            if (res == "ignored")
                logger.tick("AbuseSet@ignored")
            else if (res == "active")
                logger.tick("AbuseSet@active")
            else
                logger.tick("AbuseSet@other");

            await core.pubsContainer.updateAsync(req.rootId, async(entry1: JsonBuilder) => {
                core.setFields(entry1["pub"], req.body, ["resolution"]);
            });
            await core.pubsContainer.updateAsync(pub["publicationid"], async (entry2: JsonBuilder) => {
                entry2["abuseStatus"] = res;
                delete entry2["abuseStatusPosted"];
            });
            req.response = ({});
        }
    });
    core.addRoute("POST", "*pub", "abusereports", async(req: core.ApiRequest) => {
        await core.throttleAsync(req, "pub", 60);
        if (req.status != 200) return;
        if (!req.userid) {
            let uid = orEmpty(core.serviceSettings.accounts["anonreport"]);
            if (!uid) {
                req.status = httpCode._403Forbidden;
            } else {
                await core.setReqUserIdAsync(req, uid);
            }    
        }
        if (req.status != 200) return;        
        await postAbusereportAsync(req);
    });
    core.addRoute("DELETE", "*user", "", async (req8: core.ApiRequest) => {
        await checkDeletePermissionAsync(req8);
        // Level4 users cannot be deleted; you first have to downgrade their permissions.
        if (req8.status == 200 && core.hasPermission(req8.rootUser(), "level4")) {
            req8.status = httpCode._402PaymentRequired;
        }
        if (req8.status == 200) {
            await deleteUserAsync(req8);
            req8.response = ({ "msg": "have a nice life" });
        }
    });
    core.addRoute("DELETE", "*pub", "", async (req: core.ApiRequest) => {
        if (canBeAdminDeleted(req.rootPub)) {
            await checkDeletePermissionAsync(req);
            if (req.status == 200) {
                await audit.logAsync(req, "delete", {
                    oldvalue: await audit.auditDeleteValueAsync(req.rootPub)
                });
                if (req.userid != req.rootPub["pub"]["userid"]) {
                    await notifications.sendAsync(req.rootPub, "deleted", null);
                }
                await deletePubRecAsync(req.rootPub);
                req.response = ({});
            }
        }
        else {
            req.status = httpCode._405MethodNotAllowed;
        }
    });
    core.addRoute("GET", "*pub", "candelete", async (req: core.ApiRequest) => {
        let resp = new CandeleteResponse();
        let pub1 = req.rootPub["pub"];
        resp.publicationkind = req.rootPub["kind"];
        resp.publicationname = withDefault(pub1["name"], "/" + req.rootId);
        resp.publicationuserid = getAuthor(pub1);
        resp.candeletekind = canBeAdminDeleted(req.rootPub) || core.hasSpecialDelete(req.rootPub);
        let reports = await abuseReports.getIndex("publicationid").fetchAsync(req.rootId, ({"count":10}));
        resp.hasabusereports = reports.items.length > 0 || reports.continuation != "";
        if (resp.candeletekind) {
            await checkDeletePermissionAsync(req);
            if (req.status == 200) {
                resp.candelete = true;
                if (resp.publicationuserid == req.userid) {
                    await core.checkFacilitatorPermissionAsync(req, resp.publicationuserid);
                    if (req.status == 200) {
                        resp.canmanage = true;
                    }
                    else {
                        resp.canmanage = false;
                        req.status = 200;
                    }
                }
                else {
                    resp.canmanage = true;
                }
            }
            else {
                resp.candelete = false;
                req.status = 200;
            }
            
            if (core.hasPermission(req.userinfo.json, "any-facilitator"))
                resp.canmanage = true;
        }
        req.response = resp.toJson();
    });
}


async function deletePubRecAsync(delEntry: JsonObject) : Promise<void>
{
    if (delEntry["kind"] == "review") {
        let delok3 = await tdliteReviews.deleteReviewAsync(delEntry);
    }
    else {
        let delok = await core.deleteAsync(delEntry);
        if (delok) {
            // TODO handle updateId stuff for scripts
            // TODO delete comments on this publication
            // TODO update comment counts
            let kind = delEntry["kind"];
            let entryid = delEntry["id"];
            let desc = core.getPubKind(kind)

            if (desc && desc.specialDeleteAsync)
                await desc.specialDeleteAsync(entryid, delEntry)

            let abuses = await abuseReports.getIndex("publicationid").fetchAllAsync(entryid);
            await parallel.forJsonAsync(abuses, async (json1: JsonObject) => {
                await core.pubsContainer.updateAsync(json1["id"], async (entry2: JsonBuilder) => {
                    entry2["pub"]["resolution"] = "deleted";
                });
                logger.tick("AbuseSet@deleted")
            });

        }
    }
}

async function postAbusereportAsync(req: core.ApiRequest, acsInfo = "") : Promise<void>
{
    let baseKind = req.rootPub["kind"];
    if ( ! canHaveAbuseReport(baseKind)) {
        req.status = httpCode._412PreconditionFailed;
    }
    else {
        let report = new PubAbusereport();
        report.text = core.encrypt(orEmpty(req.body["text"]), "ABUSE");
        report.userplatform = core.getUserPlatforms(req);
        report.userid = req.userid;
        report.time = await core.nowSecondsAsync();
        report.publicationid = req.rootId;
        report.publicationkind = baseKind;
        let pub = req.rootPub["pub"];
        report.publicationname = orEmpty(pub["name"]);
        report.publicationuserid = getAuthor(pub);
        let jsb = {};
        jsb["pub"] = report.toJson();
        if (acsInfo)
            jsb["acsInfo"] = acsInfo;
        await core.generateIdAsync(jsb, 10);
        await abuseReports.insertAsync(jsb);
        await core.pubsContainer.updateAsync(report.publicationid, async (entry: JsonBuilder) => {
            if (! entry["abuseStatus"]) {
                entry["abuseStatus"] = "active";
            }
            entry["abuseStatusPosted"] = "active";
            core.bareIncrement(entry, "numAbuses");
        });        
        await tdliteUsers.updateAsync(report.publicationuserid, async(entry) => {
            entry.numAbusesByUser++;
        });               
        await tdliteUsers.updateAsync(report.userid, async(entry) => {
            entry.numReports++;
        })
        await notifications.storeAsync(req, jsb, "");
        await core.returnOnePubAsync(abuseReports, td.clone(jsb), req);
    }
}

function getAuthor(pub: JsonObject) : string
{
    let author = pub["userid"];
    if (pub["kind"] == "user") {
        author = pub["id"];
    }
    return author;
}

export function canHaveAbuseReport(baseKind: string) : boolean
{
    return /^(art|comment|script|screenshot|channel|group|user)$/.test(baseKind);    
}

async function deleteUserAsync(req:core.ApiRequest)
{
    await tdliteWorkspace.deleteAllHistoryAsync(req.rootId, req);

    for (let pk of core.getPubKinds()) {
        // TODO We leave groups alone - rethink.
        if (pk.deleteWithAuthor)
            await deleteAllByUserAsync(pk.store, req.rootId, req);
    }

    // Bugs, releases, etc just stay
    
    let delok = await core.deleteAsync(req.rootPub);
    logger.debug("delete user: " + JSON.stringify(req.rootPub) + " - " + delok);
    await audit.logAsync(req, "delete", {
        oldvalue: req.rootPub
    });
}

async function deleteAllByUserAsync(store: indexedStore.Store, id: string, req: core.ApiRequest) : Promise<void>
{
    let logDelete = store.kind != "review";
    await store.getIndex("userid").forAllBatchedAsync(id, 50, async (json) => {
        await parallel.forJsonAsync(json, async (json1: JsonObject) => {
            if (logDelete) {
                await audit.logAsync(req, "delete-by-user", {
                    publicationid: json1["id"],
                    oldvalue: await audit.auditDeleteValueAsync(json1),
                    publicationkind: json1["kind"]
                });
            }
            await deletePubRecAsync(json1);
        });
    });
}

function canBeAdminDeleted(jsonpub: JsonObject) : boolean
{
    let b: boolean;
    b = /^(art|screenshot|comment|script|group|publist|channel|pointer)$/.test(jsonpub["kind"]);
    return b;
}

async function checkDeletePermissionAsync(req: core.ApiRequest): Promise<void> {
    let pub = req.rootPub["pub"];
    let authorid = pub["userid"];
    if (pub["kind"] == "user") {
        authorid = pub["id"];
    }
    if (authorid == req.userid) return; // ok, my content
    
    if (pub["kind"] == "comment") {
        let rootpub = await tdliteComments.getRootPubAsync(req.rootPub);
        if (rootpub && rootpub["kind"] == "group") {
            if (rootpub["pub"]["userid"] == req.userid)
                return; // OK, I can delete comments on my group
        }
    }

    await core.checkFacilitatorPermissionAsync(req, authorid);
}

function buildRecognizer(words:string[])
{
    let root = {}
    
    for (let word of words) {
        word = word.toLowerCase().replace(/\&nbsp;/g, " ");
        let ptr = root
        for (let c of word) {
            if (!ptr.hasOwnProperty(c)) {
                ptr[c] = {}
            }
            ptr = ptr[c]
        }
        ptr["_match"] = 1
    }
    
    return root
}

function scanCore(tree: {}, str: string) {
    let hits: string[] = []
    let issep = c => /^[^a-z0-9]$/.test(c);

    str = " " + str.toLowerCase() + " ";

    for (let i = 0; i < str.length; ++i) {
        if (!issep(str[i])) continue;
        let ptr = tree;
        for (let j = 1; !!ptr; ++j) {
            let c = str[i + j];            
            if (!c) break;
            if (ptr["_match"] && issep(c)) {
                hits.push(str.substr(i + 1, j - 1))
            }
            ptr = ptr[c];
        }
    }
    
    return hits;
}

function initScanner() {
    if (wordRecognizer) return;
    let sett = core.getSettings("scanner")    
    wordRecognizer = buildRecognizer(sett["words"] || [])
    scannerRegexes = {}
    let reg = sett["regexps"]
    for (let rxname of Object.keys(reg)) {
        scannerRegexes[rxname] = new RegExp("\\b(" + reg[rxname] + ")\\b");        
    }
}

function scanText(txt: string, candolinks: boolean, isdesc:boolean) {
    let res = ""

    initScanner();

    let hits = scanCore(wordRecognizer, txt);

    if (hits.length > 0) {
        res += "Word hits: " + hits.join(", ") + ".\n"
    }

    if (candolinks) {
        logger.debug("skipping regexp scanning")
    } else {
        for (let rxname of Object.keys(scannerRegexes)) {
            if (rxname.endsWith("*") && !isdesc) continue;
            let m = scannerRegexes[rxname].exec(txt)
            if (m) {
                res += rxname + ": " + m[0] + ".\n"
            }
        }
    }

    return res;
}

export async function postAcsReport(pubid: string, msg: string, acsInfo:string = null, req: core.ApiRequest = null) {
    let uid = orEmpty(core.serviceSettings.accounts["acsreport"]);
    if (uid != "") {
        if (!req)
            req = core.buildApiRequest("/api/" + pubid + "/abuse");
        await core.setReqUserIdAsync(req, uid);
        req.rootPub = await core.pubsContainer.getAsync(pubid);
        if (core.isGoodEntry(req.rootPub)) {
            req.body = {
                text: msg
            };
            req.rootId = pubid;
            await postAbusereportAsync(req, acsInfo);
        }
    }
}

export async function scanAndPostAsync(pubid: string, body: string, desc:string, userjson: core.IUser) {
    let msg = scanText(body, core.hasPermission(userjson, "external-links"), false);
    msg += scanText(desc, core.hasPermission(userjson, "external-links"), true);
    if (msg) {
        await postAcsReport(pubid, msg);
    }    
}

function testscanner()
{
    let t0 = buildRecognizer(["foo", "b-rhello"]);
    let numerr = 0
    let tst = (s, e) => {
        let r = scanCore(t0, s).join(",")
        let err = ""
        if (e != r) {
            numerr++;
            err = `ERROR, exp: '${e}'`
        }
        console.log(`${s} => '${r}' ${err}`)
    }
        
    tst("hello","")
    tst("hellofoo","")
    tst("foohello", "")
    tst("Foo", "foo")
    tst("hello foo() bar", "foo")
    tst("hello ()b-rhello() bar", "b-rhello")
    tst("hello ()b-rhelloss() bar", "")
    
    
    /*
    let tt = require('fs').readFileSync("test.txt", "utf8") + " fo.bar@baz.com hello"
    let r = new RegExp("\\b(\\s*\\(?0\\d{4}\\)?\\s*\\d{6}\\s*)|(\\s*\\(?0\\d{3}\\)?\\s*\\d{3}\\s*\\d{4}\\s*)\\b");    
    console.log(tt.length)
    console.log(!!r.exec(tt))
    //console.log(r.exec(tt))
    //let w = JSON.parse(require('fs').readFileSync("words.json", "utf8")).words
    */
}

if (!module.parent)
    testscanner();
