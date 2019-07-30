"use strict";

const PATH = require("path");    
const PLAN_REVIEWER = require("./lib/PlanReviewer"); 

let main = function() {   

    let fileName = (process.argv.length < 3) ? "plan.json" : process.argv[2];     
    let planFile = PATH.join(process.cwd(), fileName);    
    let reviewer = new PLAN_REVIEWER();
    reviewer.process(planFile);
}

main();