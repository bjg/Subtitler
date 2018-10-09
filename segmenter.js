#!/usr/bin/env node

/*	
 * Copyright IBM Corp. 2017
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var chalk = require("chalk");
var clear = require("clear");
var CLI = require("clui");
var figlet = require("figlet");
var inquirer = require("inquirer");
var Spinner = CLI.Spinner;
var _ = require("lodash");
var files = require("./lib/files");
var request = require("request");
var moment = require("moment");
require("moment-duration-format");

function processSubtitles(callback) {
    var argv = require("minimist")(process.argv.slice(2));

    var questions = [
        {
            name: "filename",
            type: "input",
            message: "Enter the file name of the speech events file:",
            default: argv._[0] || null,
            validate: function(value) {
                if (value.length) {
                    return true;
                } else {
                    return "Please enter the file name of the speech events";
                }
            }
        },
        {
            name: "source",
            type: "input",
            message: "Enter the BCP source language code or customization id:",
            default: argv._[1] || "en",
            validate: function(value) {
                if (value.length) {
                    return true;
                } else {
                    return "Enter the BCP source language code or customization id";
                }
            }
        },
        {
            name: "service",
            type: "input",
            message:
                "Enter the id of segmentation service: \n" +
                "0: http://bark.phon.ioc.ee/punctuator \n" +
                "1: https://punctuationservice.mybluemix.net \n",
            default: argv._[2] || "0",
            validate: function(value) {
                value = value + "";
                if (value.length) {
                    return true;
                } else {
                    return "Enter the id of segmentation service";
                }
            }
        }
    ];

    inquirer.prompt(questions).then(function(answers) {
        var status = new Spinner(chalk.green("Segmenting subtitles..."));
        var parser = require("subtitles-parser");
        var speechEvents = [];
        status.start();

        if (answers.source != "en") {
            status.stop();
            console.log("Only English segmentation is currently supported");
            return callback({ message: "Unsuported language" });
        }

        if (answers.service != 0 && answers.service != 1) {
            status.stop();
            console.log("Need input proper segmentation service id");
            return callback({ message: "Unsuported segmentation service id" });
        }

        // Read all the raw speech events
        try {
            speechEvents = JSON.parse(files.read(answers.filename));
        } catch (err) {
            console.log(err.message);
            status.stop();
            return callback(err);
        }

        generateSegments(speechEvents, answers.service, function(err, data) {
            if (err) {
                console.log(err.message);
                status.stop();
                return callback(err);
            } else {
                var sentences = sentenceSplit(data, 65);
                var wordTimes = flatten(speechEvents);

                var subs = formatSubtitles(sentences, wordTimes);

                var srtSubs = parser.toSrt(subs);
                files.write(files.name(answers.filename) + ".srt", srtSubs);

                status.stop();
                return callback(null);
            }
        });
    });
}

function sentenceSplit(data, maxWidth) {
    let sentence = "";
    const all = data.split(/\s+/).reduce((acc, word) => {
        if (sentence.length + word.length <= maxWidth) {
            sentence += " " + word;
        } else {
            // This sentence is done. Next one starts with the current word
            acc.push(sentence.trim());
            sentence = word;
        }
        return acc;
    }, []);
    // Add the last sentence
    all.push(sentence.trim());
    return all;
}

function countWords(s) {
    s = s.replace(/\n/g, " "); // newlines to space
    s = s.replace(/\t/g, " "); // newlines to space
    s = s.replace(/(^\s*)|(\s*$)/gi, ""); // remove spaces from start + end
    s = s.replace(/[ ]{2,}/gi, " "); // 2 or more spaces to 1
    return s.split(" ").length;
}

function flatten(events) {
    var words = [];

    for (var i = 0; i < events.length; ++i) {
        var elements = events[i].words;
        words = words.concat(elements);
    }
    return words;
}

function formatSubtitles(segments, wordTimes) {
    var srtJSON = [];
    var lastTimeIndex = 0;

    /* 
    Iterate across all the new text segments and find the corresponding times for when the 
    text segement should be displayed by looking up the times in the the wordTimes array 
    */
    for (var i = 0; i < segments.length; ++i) {
        var subtitle = {
            id: "0",
            startTime: "",
            endTime: "",
            text: ""
        };

        subtitle.id = String(i + 1);

        // Save the subtile text and remove any dashes
        subtitle.text = segments[i].replace(/-/, "");

        let startTime;
        for (;;) {
            // XXX Hack alert. Sometimes the lastTimeIndex gets out of sync so this
            // kludge just finds right one
            try {
                startTime = wordTimes[lastTimeIndex][1];
            } catch {
                lastTimeIndex--;
                continue;
            }
            break;
        }
        subtitle.startTime = moment.duration(startTime, "seconds").format("hh:mm:ss,SSS", {
            trim: false
        });

        // Move the index to the first word in the next segment, by counting the words in the current segment
        lastTimeIndex = lastTimeIndex + countWords(subtitle.text);

        // Get the end time for when the last word is spoken in the segment
        let endTime;
        for (;;) {
            // XXX Hack alert. Sometimes the lastTimeIndex gets out of sync so this
            // kludge just finds right one
            try {
                endTime = wordTimes[lastTimeIndex - 1][2];
            } catch {
                lastTimeIndex--;
                continue;
            }
            break;
        }
        subtitle.endTime = moment.duration(endTime, "seconds").format("hh:mm:ss,SSS", {
            trim: false
        });

        srtJSON.push(subtitle);
    }
    return srtJSON;
}

function generateSegments(speechEvents, serviceId, callback) {
    var srt = "";
    var subtitles = "";
    var transcript = "";
    var seg_services = ["http://bark.phon.ioc.ee/punctuator", "https://punctuationservice.mybluemix.net/api/punctext"];

    for (var i = 0; i < speechEvents.length; ++i) {
        if (transcript === "") {
            transcript = speechEvents[i].text;
        } else {
            transcript = transcript + speechEvents[i].text;
        }
    }

    // Call the web service to create segments from the raw text strings
    request.post(
        seg_services[serviceId],
        {
            form: {
                text: transcript
            }
        },
        function(err, res) {
            if (err) {
                return callback(err);
            }
            {
                return callback(null, res.body);
            }
        }
    );
}

clear();
console.log(
    chalk.yellow(
        figlet.textSync("Segmented Subtitle Generator", {
            horizontalLayout: "full"
        })
    )
);

processSubtitles(function(err, rawText) {
    if (err) {
        console.log("Failed to segment subtitles");
    } else {
        console.log("Segmented subtitle file created");
    }
});
