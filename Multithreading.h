#ifndef MULTITHREADING_H
#define MULTITHREADING_H

#include <mutex>

struct job_t {
    void  (*function)(void*);   // Job instructions
    void* data;                 // Job parameters
    int    executed;            // Job end marker...Not used.
};

#endif